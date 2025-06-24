// Fixed Xerox FTP to Egnyte Gateway
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { FtpSrv } = require('ftp-srv');
const axios = require('axios');

// Configuration
const CONFIG = {
    FTP_PORT: parseInt(process.env.FTP_PORT) || 2121,
    FTP_HOST: process.env.FTP_HOST || '0.0.0.0',
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

// Upload queue and session tracking
const uploadQueue = [];
const userSessions = new Map();
let processTimer = null;
const IDLE_TIMEOUT = 10000; // 10 seconds

// Egnyte upload function
async function uploadToEgnyte(filePath, egnytePath) {
    console.log(`📤 Uploading: ${path.basename(filePath)}`);
    
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

// Process upload queue with delays
async function processUploadQueue() {
    if (uploadQueue.length === 0) {
        console.log('📋 No files to process');
        return;
    }
    
    console.log(`🚀 Processing ${uploadQueue.length} files for Egnyte...`);
    
    let success = 0;
    let failed = 0;
    
    // Process all queued files
    const filesToProcess = [...uploadQueue];
    uploadQueue.length = 0; // Clear queue
    
    for (let i = 0; i < filesToProcess.length; i++) {
        const item = filesToProcess[i];
        
        try {
            await uploadToEgnyte(item.localPath, item.egnytePath);
            
            // Delete local file after successful upload
            fs.unlinkSync(item.localPath);
            console.log(`✅ Uploaded and deleted: ${item.fileName}`);
            success++;
            
        } catch (error) {
            console.error(`❌ Failed to upload ${item.fileName}:`, error.message);
            failed++;
        }
        
        // Wait before next upload (except for last file)
        if (i < filesToProcess.length - 1) {
            console.log(`⏳ Waiting ${CONFIG.UPLOAD_DELAY}ms before next upload...`);
            await new Promise(resolve => setTimeout(resolve, CONFIG.UPLOAD_DELAY));
        }
    }
    
    console.log(`🏁 Batch complete: ${success} success, ${failed} failed`);
}

// Start idle timer for processing uploads
function startProcessTimer() {
    // Clear any existing timer
    if (processTimer) {
        clearTimeout(processTimer);
    }
    
    // Start new timer
    processTimer = setTimeout(() => {
        console.log(`⏰ Idle timeout reached, starting batch processing...`);
        processUploadQueue();
        processTimer = null;
    }, IDLE_TIMEOUT);
    
    console.log(`⏳ Processing timer set for ${IDLE_TIMEOUT/1000} seconds`);
}

// Create FTP server with minimal timeouts
const ftpServer = new FtpSrv({
    url: `ftp://${CONFIG.FTP_HOST}:${CONFIG.FTP_PORT}`,
    anonymous: false,
    pasv_url: CONFIG.FTP_HOST,
    pasv_min: 1024,
    pasv_max: 1048,
    greeting: 'Xerox Scanner Gateway Ready'
});

// Handle authentication and file uploads
ftpServer.on('login', ({ connection, username, password }, resolve, reject) => {
    console.log(`🔐 Login attempt: ${username}`);
    
    // Check credentials
    if (!userMappings[username] || userMappings[username].password !== password) {
        console.log(`❌ Authentication failed for ${username}`);
        reject(new Error('Authentication failed'));
        return;
    }
    
    console.log(`✅ User ${username} authenticated`);
    
    // Store user session info
    userSessions.set(connection, {
        username: username,
        userInfo: userMappings[username],
        startTime: Date.now()
    });
    
    // Set working directory
    resolve({
        root: CONFIG.SCAN_DIR,
        cwd: '/'
    });
    
    // Handle file uploads
    connection.on('STOR', (error, filePath) => {
        if (error) {
            console.error(`❌ Upload error: ${error.message}`);
            return;
        }
        
        const session = userSessions.get(connection);
        if (!session) return;
        
        const fileName = path.basename(filePath);
        const egnytePath = `${session.userInfo.egnytePath}/${fileName}`;
        
        console.log(`📁 File received: ${fileName} from ${session.username}`);
        
        // Add to upload queue
        uploadQueue.push({
            localPath: filePath,
            egnytePath: egnytePath,
            fileName: fileName,
            username: session.username
        });
        
        console.log(`📋 Queued: ${fileName} (${uploadQueue.length} total)`);
        
        // Start/restart the processing timer
        startProcessTimer();
    });
    
    // Handle disconnect
    connection.on('close', () => {
        const session = userSessions.get(connection);
        if (session) {
            console.log(`👋 User ${session.username} disconnected`);
            userSessions.delete(connection);
        }
    });
    
    connection.on('end', () => {
        const session = userSessions.get(connection);
        if (session) {
            console.log(`🔌 Connection ended for ${session.username}`);
            userSessions.delete(connection);
        }
    });
});

// Start server
ftpServer.listen().then(() => {
    console.log(`🚀 FTP Server started on ${CONFIG.FTP_HOST}:${CONFIG.FTP_PORT}`);
    console.log(`📂 Scan directory: ${CONFIG.SCAN_DIR}`);
    console.log(`🌐 Egnyte domain: ${CONFIG.EGNYTE_DOMAIN}`);
    console.log('📋 Ready for Xerox connections!');
}).catch(error => {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
});