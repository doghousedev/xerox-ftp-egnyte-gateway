// Xerox Scanner FTP to Egnyte Gateway
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const ftpd = require('ftpd');
const axios = require('axios');

// Configuration
const CONFIG = {
    FTP_PORT: process.env.FTP_PORT || 2121,
    FTP_HOST: process.env.FTP_HOST || '0.0.0.0',
    SCAN_DIR: './scans',
    USER_MAPPING: './config/user-mapping.json',
    EGNYTE_TOKEN: process.env.EGNYTE_API_TOKEN,
    EGNYTE_DOMAIN: process.env.EGNYTE_DOMAIN,
    UPLOAD_DELAY: 3000 // 3 seconds between uploads
};

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

// Upload queue for batch processing
const uploadQueue = [];
const userSessions = new Map(); // Track active user sessions

// Egnyte upload function
async function uploadToEgnyte(filePath, egnytePath) {
    const url = `https://${CONFIG.EGNYTE_DOMAIN}/pubapi/v1/fs-content/${egnytePath}`;
    const fileStream = fs.createReadStream(filePath);
    
    const response = await axios.post(url, fileStream, {
        headers: {
            'Authorization': `Bearer ${CONFIG.EGNYTE_TOKEN}`,
            'Content-Type': 'application/octet-stream'
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
    });
    
    return response.data;
}

// Process upload queue with delays
async function processUploadQueue() {
    if (uploadQueue.length === 0) return;
    
    console.log(`🚀 Processing ${uploadQueue.length} files for Egnyte upload...`);
    
    for (const item of uploadQueue) {
        try {
            console.log(`📤 Uploading: ${item.fileName}`);
            await uploadToEgnyte(item.localPath, item.egnytePath);
            
            // Delete local file after successful upload
            fs.unlinkSync(item.localPath);
            console.log(`✅ Uploaded and deleted: ${item.fileName}`);
            
            // Wait before next upload
            if (uploadQueue.indexOf(item) < uploadQueue.length - 1) {
                await new Promise(resolve => setTimeout(resolve, CONFIG.UPLOAD_DELAY));
            }
        } catch (error) {
            console.error(`❌ Failed to upload ${item.fileName}:`, error.message);
        }
    }
    
    // Clear queue
    uploadQueue.length = 0;
    console.log('🏁 Batch upload completed');
}

// FTP Server setup
const server = new ftpd.FtpServer(CONFIG.FTP_HOST, {
    getInitialCwd: () => '/',
    getRoot: () => CONFIG.SCAN_DIR,
    pasvPortRangeStart: 1024,
    pasvPortRangeEnd: 1048,
    tlsOptions: null,
    allowUnauthorizedTls: true,
    useWriteFile: false,
    useReadFile: false,
    uploadMaxSlurpSize: 1024 * 1024 * 10 // 10MB
});

// Authentication
server.on('client:connected', (connection) => {
    let currentUser = null;
    
    connection.on('command:user', (user, success, failure) => {
        if (userMappings[user]) {
            currentUser = user;
            success();
        } else {
            failure();
        }
    });
    
    connection.on('command:pass', (pass, success, failure) => {
        if (currentUser && userMappings[currentUser] && userMappings[currentUser].password === pass) {
            console.log(`✅ User ${currentUser} authenticated`);
            userSessions.set(connection, {
                username: currentUser,
                userInfo: userMappings[currentUser],
                startTime: Date.now()
            });
            success(currentUser);
        } else {
            failure();
        }
    });
    
    // File upload completed
    connection.on('file:stored', (filePath) => {
        const session = userSessions.get(connection);
        if (!session) return;
        
        const fileName = path.basename(filePath);
        const egnytePath = `${session.userInfo.egnytePath}/${fileName}`.replace('//', '/');
        
        console.log(`📁 File received: ${fileName} from ${session.username}`);
        
        // Add to upload queue
        uploadQueue.push({
            localPath: filePath,
            egnytePath: egnytePath,
            fileName: fileName,
            username: session.username
        });
        
        console.log(`📋 Queued for upload: ${fileName} (${uploadQueue.length} total)`);
    });
    
    // Session ended - process uploads
    connection.on('end', () => {
        const session = userSessions.get(connection);
        if (session) {
            console.log(`👋 User ${session.username} disconnected`);
            userSessions.delete(connection);
            
            // Process uploads after user disconnects
            setTimeout(() => {
                processUploadQueue();
            }, 1000);
        }
    });
});

// Start server
server.listen(CONFIG.FTP_PORT);
console.log(`🚀 FTP Server started on port ${CONFIG.FTP_PORT}`);
console.log(`📂 Scan directory: ${CONFIG.SCAN_DIR}`);
console.log(`🌐 Egnyte domain: ${CONFIG.EGNYTE_DOMAIN}`);
console.log('📋 Ready for Xerox connections!');