// Simple Xerox FTP to Egnyte Gateway
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { FTPServer } = require('ftp-server');
const axios = require('axios');

// Configuration
const CONFIG = {
    FTP_PORT: parseInt(process.env.FTP_PORT) || 2121,
    SCAN_DIR: './scans',
    USER_MAPPING: './config/user-mapping.json',
    EGNYTE_TOKEN: process.env.EGNYTE_API_TOKEN,
    EGNYTE_DOMAIN: process.env.EGNYTE_DOMAIN,
    UPLOAD_DELAY: 3000
};

console.log('🔧 Starting Xerox FTP Gateway...');

// Load user mappings
let userMappings = {};
try {
    userMappings = JSON.parse(fs.readFileSync(CONFIG.USER_MAPPING, 'utf8'));
    console.log('✅ Loaded users:', Object.keys(userMappings).join(', '));
} catch (error) {
    console.error('❌ Failed to load user mappings:', error.message);
    process.exit(1);
}

// Create scan directory
if (!fs.existsSync(CONFIG.SCAN_DIR)) {
    fs.mkdirSync(CONFIG.SCAN_DIR, { recursive: true });
}

// Upload queue
const uploadQueue = [];

// Egnyte upload function
async function uploadToEgnyte(filePath, egnytePath) {
    console.log(`📤 Uploading to Egnyte: ${path.basename(filePath)}`);
    
    const cleanPath = egnytePath.startsWith('/') ? egnytePath.substring(1) : egnytePath;
    const url = `https://${CONFIG.EGNYTE_DOMAIN}/pubapi/v1/fs-content/${cleanPath}`;
    const fileStream = fs.createReadStream(filePath);
    
    const response = await axios.post(url, fileStream, {
        headers: {
            'Authorization': `Bearer ${CONFIG.EGNYTE_TOKEN}`,
            'Content-Type': 'application/octet-stream'
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 30000
    });
    
    return response.data;
}

// Process upload queue
async function processUploads() {
    if (uploadQueue.length === 0) {
        console.log('📋 No files to upload');
        return;
    }
    
    console.log(`🚀 Processing ${uploadQueue.length} files...`);
    
    let success = 0;
    let failed = 0;
    
    for (const item of [...uploadQueue]) {
        try {
            await uploadToEgnyte(item.localPath, item.egnytePath);
            fs.unlinkSync(item.localPath);
            console.log(`✅ Uploaded and deleted: ${item.fileName}`);
            success++;
            
            // Remove from queue
            const index = uploadQueue.indexOf(item);
            if (index > -1) uploadQueue.splice(index, 1);
            
            // Wait before next upload
            if (uploadQueue.length > 0) {
                await new Promise(resolve => setTimeout(resolve, CONFIG.UPLOAD_DELAY));
            }
        } catch (error) {
            console.error(`❌ Failed to upload ${item.fileName}:`, error.message);
            failed++;
        }
    }
    
    console.log(`🏁 Upload complete: ${success} success, ${failed} failed`);
}

// Create FTP server
const server = new FTPServer({
    host: '0.0.0.0',
    port: CONFIG.FTP_PORT,
    root: CONFIG.SCAN_DIR
});

// Authentication
server.on('login', (data, resolve, reject) => {
    const { username, password } = data;
    
    if (userMappings[username] && userMappings[username].password === password) {
        console.log(`✅ User ${username} authenticated`);
        resolve({ message: 'Authentication successful' });
    } else {
        console.log(`❌ Failed login: ${username}`);
        reject({ message: 'Authentication failed' });
    }
});

// File uploaded
server.on('upload', (data) => {
    const { filename, user } = data;
    const userInfo = userMappings[user];
    
    if (userInfo) {
        const localPath = path.join(CONFIG.SCAN_DIR, filename);
        const egnytePath = `${userInfo.egnytePath}/${filename}`;
        
        console.log(`📁 File uploaded: ${filename} by ${user}`);
        
        uploadQueue.push({
            localPath,
            egnytePath,
            fileName: filename,
            username: user
        });
        
        console.log(`📋 Queued: ${filename} (${uploadQueue.length} total)`);
    }
});

// User disconnected
server.on('disconnect', (data) => {
    console.log(`👋 User ${data.user} disconnected`);
    
    // Process uploads after disconnect
    setTimeout(processUploads, 2000);
});

// Start server
server.start().then(() => {
    console.log(`🚀 FTP Server running on port ${CONFIG.FTP_PORT}`);
    console.log(`📂 Root directory: ${CONFIG.SCAN_DIR}`);
    console.log('📋 Ready for connections!');
}).catch(error => {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
});