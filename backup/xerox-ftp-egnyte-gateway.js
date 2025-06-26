// Production Xerox FTP to Egnyte Gateway v31
// Load environment configuration from current directory
require('dotenv').config();

// Check if ftp-srv is installed
let FtpSrv;
try {
    FtpSrv = require('ftp-srv').FtpSrv;
} catch (error) {
    console.error('❌ Error: ftp-srv module not found');
    console.log('📦 Please install it first:');
    console.log('   npm install ftp-srv dotenv axios form-data');
    process.exit(1);
}

const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const FormData = require('form-data');

// Configuration from environment variables with defaults
const CONFIG = {
    FTP: {
        PORT: process.env.FTP_PORT || 2121,
        HOST: process.env.FTP_HOST || getLocalIpAddress(),
        MAX_CONNECTIONS: parseInt(process.env.FTP_MAX_CONNECTIONS) || 10,
        IDLE_TIMEOUT: parseInt(process.env.FTP_IDLE_TIMEOUT) || 60000,
        AUTO_DISCONNECT_DELAY: parseInt(process.env.FTP_AUTO_DISCONNECT_DELAY) || 10000,
        WELCOME_MESSAGE: process.env.FTP_WELCOME_MESSAGE || 'Xerox Document Scanner FTP Gateway'
    },
    PATHS: {
        SCAN_DROP_DIRECTORY: process.env.SCAN_DROP_DIRECTORY || './scans',
        USER_MAPPING_FILE: process.env.USER_MAPPING_FILE || './config/user-mapping.json'
    },
    EGNYTE: {
        API_TOKEN: process.env.EGNYTE_API_TOKEN,
        DOMAIN: process.env.EGNYTE_DOMAIN,
        BASE_PATH: process.env.EGNYTE_BASE_PATH || '/Shared',
        UPLOAD_TIMEOUT: parseInt(process.env.EGNYTE_UPLOAD_TIMEOUT) || 30000
    },
    EMAIL: {
        SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
        SMTP_PORT: parseInt(process.env.SMTP_PORT) || 587,
        SMTP_USER: process.env.SMTP_USER,
        SMTP_PASSWORD: process.env.SMTP_PASSWORD,
        EMAIL_FROM: process.env.EMAIL_FROM,
        EMAIL_SUBJECT: process.env.EMAIL_SUBJECT || 'New Scan Available'
    },
    LOGGING: {
        LOG_LEVEL: process.env.LOG_LEVEL || 'info'
    }
};

// Validate required configuration
function validateConfig() {
    const required = [
        { key: 'EGNYTE_API_TOKEN', value: CONFIG.EGNYTE.API_TOKEN },
        { key: 'EGNYTE_DOMAIN', value: CONFIG.EGNYTE.DOMAIN }
    ];
    
    const missing = required.filter(item => !item.value);
    if (missing.length > 0) {
        console.error('❌ Missing required configuration:');
        missing.forEach(item => console.error(`   - ${item.key}`));
        console.log('💡 Create a .env file or set environment variables');
        process.exit(1);
    }
}

// Get local IP address
function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const interface of interfaces[name]) {
            if (interface.family === 'IPv4' && !interface.internal) {
                return interface.address;
            }
        }
    }
    return '127.0.0.1';
}

// Logger utility
const logger = {
    info: (msg, ...args) => console.log(`ℹ️  ${msg}`, ...args),
    success: (msg, ...args) => console.log(`✅ ${msg}`, ...args),
    warning: (msg, ...args) => console.log(`⚠️  ${msg}`, ...args),
    error: (msg, ...args) => console.error(`❌ ${msg}`, ...args),
    debug: (msg, ...args) => {
        if (CONFIG.LOGGING.LOG_LEVEL === 'debug') {
            console.log(`🔍 ${msg}`, ...args);
        }
    }
};

// Load user mappings
let userMappings = {};
function loadUserMappings() {
    try {
        logger.info('Loading user mappings from:', CONFIG.PATHS.USER_MAPPING_FILE);
        
        if (!fs.existsSync(CONFIG.PATHS.USER_MAPPING_FILE)) {
            logger.error('user-mapping.json not found at:', CONFIG.PATHS.USER_MAPPING_FILE);
            process.exit(1);
        }
        
        const userMappingsData = fs.readFileSync(CONFIG.PATHS.USER_MAPPING_FILE, 'utf8');
        userMappings = JSON.parse(userMappingsData);
        logger.success('Loaded user mappings for:', Object.keys(userMappings).join(', '));
    } catch (error) {
        logger.error('Error loading user-mapping.json:', error.message);
        process.exit(1);
    }
}

// Egnyte API integration - Real implementation
class EgnyteClient {
    constructor() {
        this.apiToken = CONFIG.EGNYTE.API_TOKEN;
        this.domain = CONFIG.EGNYTE.DOMAIN;
        
        // Fix domain URL construction - remove .egnyte.com if already present
        const cleanDomain = this.domain.replace('.egnyte.com', '');
        this.baseUrl = `https://${cleanDomain}.egnyte.com`;
        
        // Validate configuration
        if (!this.apiToken || this.apiToken === 'your_actual_token_here') {
            throw new Error('❌ EGNYTE_API_TOKEN not configured. Please update your .env file.');
        }
        if (!this.domain) {
            throw new Error('❌ EGNYTE_DOMAIN not configured. Please update your .env file.');
        }
        
        logger.info(`🔗 Egnyte client initialized for domain: ${cleanDomain}.egnyte.com`);
        
        // Test connectivity at startup
        this.testConnection();
    }
    
    async testConnection() {
        try {
            logger.info(`🧪 Testing Egnyte connectivity...`);
            const testUrl = `${this.baseUrl}/pubapi/v1/userinfo`;
            
            const response = await fetch(testUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.apiToken}`
                },
                signal: AbortSignal.timeout(10000)
            });
            
            if (response.ok) {
                const userInfo = await response.json();
                logger.success(`✅ Egnyte connection successful!`);
                logger.info(`   👤 Connected as: ${userInfo.username || 'Unknown'}`);
                logger.info(`   🏢 Domain: ${this.domain}`);
            } else {
                logger.warning(`⚠️  Egnyte connection test failed: HTTP ${response.status}`);
                logger.warning(`   🔍 Please verify your API token and domain`);
            }
        } catch (error) {
            logger.warning(`⚠️  Egnyte connection test failed: ${error.message}`);
            logger.warning(`   🌐 Please check internet connection and Egnyte configuration`);
        }
    }
    
    async uploadFile(localFilePath, egnyteDestinationPath) {
        try {
            logger.info(`📤 Egnyte upload starting: ${egnyteDestinationPath}`);
            
            // Check if local file exists
            if (!fs.existsSync(localFilePath)) {
                throw new Error(`Local file not found: ${localFilePath}`);
            }
            
            const stats = fs.statSync(localFilePath);
            const fileName = path.basename(localFilePath);
            
            logger.info(`   📁 File: ${fileName}`);
            logger.info(`   📏 Size: ${(stats.size / 1024).toFixed(1)} KB`);
            logger.info(`   🎯 Destination: ${egnyteDestinationPath}`);
            
            // Ensure destination directory exists
            await this.ensureDirectoryExists(path.dirname(egnyteDestinationPath));
            
            // Prepare file upload
            const fileStream = fs.createReadStream(localFilePath);
            const uploadUrl = `${this.baseUrl}/pubapi/v1/fs-content${egnyteDestinationPath}`;
            
            logger.info(`   ⏳ Uploading to Egnyte...`);
            
            // Upload the file using fetch (built-in to Node.js 18+)
            const response = await fetch(uploadUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiToken}`,
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': stats.size.toString()
                },
                body: fileStream,
                duplex: 'half', // Required for streaming uploads in Node.js fetch
                signal: AbortSignal.timeout(CONFIG.EGNYTE.UPLOAD_TIMEOUT)
            });
            
            if (!response.ok) {
                let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
                try {
                    const errorData = await response.text();
                    if (errorData) {
                        errorMessage += ` - ${errorData}`;
                    }
                } catch (e) {
                    // Ignore error parsing error response
                }
                throw new Error(errorMessage);
            }
            
            // Parse response
            let responseData = {};
            try {
                const responseText = await response.text();
                if (responseText) {
                    responseData = JSON.parse(responseText);
                }
            } catch (e) {
                // Response might be empty for successful uploads
                logger.debug('No JSON response body (this is normal for some uploads)');
            }
            
            logger.success(`✅ Egnyte upload successful!`);
            logger.info(`   🗂️  File stored at: ${egnyteDestinationPath}`);
            logger.info(`   📊 Upload completed: ${(stats.size / 1024).toFixed(1)} KB transferred`);
            
            return { 
                success: true, 
                path: egnyteDestinationPath, 
                size: stats.size,
                uploadTime: new Date().toISOString(),
                egnyteResponse: responseData
            };
            
        } catch (error) {
            logger.error(`❌ Egnyte upload failed: ${error.message}`);
            logger.error(`   📁 File: ${path.basename(localFilePath)}`);
            logger.error(`   🎯 Intended destination: ${egnyteDestinationPath}`);
            logger.error(`   🔗 Upload URL: ${this.baseUrl}/pubapi/v1/fs-content${egnyteDestinationPath}`);
            
            // Log more error details
            if (error.cause) {
                logger.error(`   🔍 Error cause: ${error.cause.message || error.cause}`);
            }
            if (error.code) {
                logger.error(`   📋 Error code: ${error.code}`);
            }
            
            // Provide helpful error context
            if (error.message.includes('401')) {
                logger.error(`   🔑 Authentication failed - check EGNYTE_API_TOKEN`);
            } else if (error.message.includes('403')) {
                logger.error(`   🚫 Permission denied - check token permissions and destination path`);
            } else if (error.message.includes('404')) {
                logger.error(`   📂 Destination path not found - check Egnyte folder structure`);
            } else if (error.message.includes('timeout')) {
                logger.error(`   ⏰ Upload timed out - check network connection and file size`);
            } else if (error.message.includes('fetch failed')) {
                logger.error(`   🌐 Network error - check internet connection and Egnyte domain`);
                logger.error(`   🔍 Try: ping ${this.domain}.egnyte.com`);
            }
            
            throw error;
        }
    }
    
    async ensureDirectoryExists(directoryPath) {
        try {
            // Clean path - remove leading slash and ensure proper format
            const cleanPath = directoryPath.replace(/^\/+/, '');
            const checkUrl = `${this.baseUrl}/pubapi/v1/fs/${cleanPath}`;
            
            logger.debug(`   📂 Checking if directory exists: /${cleanPath}`);
            
            const response = await fetch(checkUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.apiToken}`
                },
                signal: AbortSignal.timeout(10000) // 10 second timeout for directory check
            });
            
            if (response.ok) {
                logger.debug(`   ✅ Directory exists: /${cleanPath}`);
                return true;
            }
            
            if (response.status === 404) {
                logger.info(`   📁 Creating directory: /${cleanPath}`);
                
                const createUrl = `${this.baseUrl}/pubapi/v1/fs/${cleanPath}`;
                const createResponse = await fetch(createUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.apiToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        action: 'add_folder'
                    }),
                    signal: AbortSignal.timeout(10000) // 10 second timeout for directory creation
                });
                
                if (!createResponse.ok) {
                    throw new Error(`Failed to create directory: HTTP ${createResponse.status}`);
                }
                
                logger.success(`   ✅ Directory created: /${cleanPath}`);
                return true;
            }
            
            throw new Error(`Failed to check directory: HTTP ${response.status}`);
            
        } catch (error) {
            logger.warning(`   ⚠️  Directory check/creation failed: ${error.message}`);
            logger.info(`   🔄 Proceeding with upload anyway...`);
            // Don't throw - proceed with upload anyway
        }
    }
}

// Initialize components
validateConfig();
loadUserMappings();

// Create scan drop directory
if (!fs.existsSync(CONFIG.PATHS.SCAN_DROP_DIRECTORY)) {
    fs.mkdirSync(CONFIG.PATHS.SCAN_DROP_DIRECTORY, { recursive: true });
    logger.info('Created scan directory:', CONFIG.PATHS.SCAN_DROP_DIRECTORY);
} else {
    logger.info('Using existing scan directory:', CONFIG.PATHS.SCAN_DROP_DIRECTORY);
}

// Initialize Egnyte client with error handling
let egnyteClient;
try {
    egnyteClient = new EgnyteClient();
} catch (error) {
    logger.error(`Failed to initialize Egnyte client: ${error.message}`);
    logger.warning(`⚠️  Server will start but uploads will fail until Egnyte is configured`);
    logger.info(`📝 Please update your .env file with valid EGNYTE_API_TOKEN`);
    egnyteClient = null;
}

// Track active connections for session management
const activeConnections = new Map();

// FTP Server configuration
const ftpServer = new FtpSrv({
    url: `ftp://${CONFIG.FTP.HOST}:${CONFIG.FTP.PORT}`,
    anonymous: false,
    pasv_url: CONFIG.FTP.HOST,
    pasv_min: 1024,
    pasv_max: 1048,
    greeting: CONFIG.FTP.WELCOME_MESSAGE
});

// Handle client connections with authentication and session management
ftpServer.on('login', ({ connection, username, password }, resolve, reject) => {
    logger.info(`Login attempt: ${username} from ${connection.ip}`);
    logger.debug(`Current active connections: ${activeConnections.size}`);
    logger.debug(`Active users: ${Array.from(activeConnections.keys()).join(', ') || 'none'}`);
    
    // Check if we have stale connections and clean them up
    for (const [user, connInfo] of activeConnections.entries()) {
        if (connInfo.connection.destroyed || connInfo.connection.readyState === 'closed') {
            logger.warning(`Cleaning up stale connection for ${user}`);
            activeConnections.delete(user);
        }
    }
    
    // Check connection limits after cleanup
    if (activeConnections.size >= CONFIG.FTP.MAX_CONNECTIONS) {
        logger.warning(`Connection limit reached (${CONFIG.FTP.MAX_CONNECTIONS} max). Rejecting ${username}`);
        logger.debug(`Active connections after cleanup: ${activeConnections.size}`);
        reject(new Error('Server busy - maximum connections reached'));
        return;
    }
    
    // Check if user exists in mappings
    if (!userMappings[username]) {
        logger.warning(`Authentication failed: Unknown user "${username}"`);
        reject(new Error(`User "${username}" not found`));
        return;
    }
    
    // Check password
    const userInfo = userMappings[username];
    if (userInfo.password !== password) {
        logger.warning(`Authentication failed: Invalid password for user "${username}"`);
        reject(new Error('Invalid password'));
        return;
    }
    
    // Check if user already has an active connection
    if (activeConnections.has(username)) {
        const existingConn = activeConnections.get(username);
        logger.warning(`User ${username} already connected. Disconnecting previous session.`);
        try {
            existingConn.connection.close();
        } catch (err) {
            logger.debug(`Could not close existing connection: ${err.message}`);
        }
        activeConnections.delete(username);
    }
    
    // Authentication successful
    logger.success(`Authentication successful for ${username}`);
    logger.info(`   📧 Email: ${userInfo.email}`);
    logger.info(`   📂 Upload directory: ${CONFIG.PATHS.SCAN_DROP_DIRECTORY}`);
    logger.info(`   🗂️  Egnyte path: ${userInfo.egnytePath}`);
    logger.info(`   👥 Active connections: ${activeConnections.size + 1}/${CONFIG.FTP.MAX_CONNECTIONS}`);
    
    // Track this connection
    const connectionInfo = {
        connection: connection,
        username: username,
        userInfo: userInfo,
        loginTime: new Date(),
        lastActivity: new Date()
    };
    activeConnections.set(username, connectionInfo);
    
    // Set up idle timeout
    let idleTimer = setTimeout(() => {
        logger.info(`Idle timeout for user ${username}. Disconnecting...`);
        activeConnections.delete(username); // Clean up immediately
        try {
            connection.close();
        } catch (err) {
            logger.debug(`Error closing connection: ${err.message}`);
        }
    }, CONFIG.FTP.IDLE_TIMEOUT);
    
    // Reset idle timer on any activity
    const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        connectionInfo.lastActivity = new Date();
        idleTimer = setTimeout(() => {
            logger.info(`Idle timeout for user ${username}. Disconnecting...`);
            activeConnections.delete(username); // Clean up immediately
            try {
                connection.close();
            } catch (err) {
                logger.debug(`Error closing connection: ${err.message}`);
            }
        }, CONFIG.FTP.IDLE_TIMEOUT);
    };
    
    resolve({ 
        root: CONFIG.PATHS.SCAN_DROP_DIRECTORY,
        cwd: '/'
    });
    
    // Listen for STOR events (file uploads)
    connection.on('STOR', async (error, filePath) => {
        resetIdleTimer();
        
        if (error) {
            logger.error('STOR Error:', error.message);
            return;
        }
        
        logger.success('File uploaded successfully!');
        logger.info(`   📁 File: ${path.basename(filePath)}`);
        logger.info(`   👤 User: ${username} (${userInfo.email})`);
        logger.info(`   🌐 Client IP: ${connection.ip}`);
        logger.info(`   ⏰ Timestamp: ${new Date().toISOString()}`);
        
        try {
            const stats = fs.statSync(filePath);
            logger.info(`   📏 File size: ${stats.size} bytes`);
            logger.info(`   🏷️  File type: ${path.extname(filePath) || 'no extension'}`);
            
            // Construct Egnyte destination path
            const fileName = path.basename(filePath);
            const egnyteDestinationPath = `${userInfo.egnytePath}/${fileName}`;
            
            // Upload to Egnyte
            if (!egnyteClient) {
                logger.error(`❌ Egnyte client not configured - cannot upload ${fileName}`);
                logger.error(`   📝 Please update EGNYTE_API_TOKEN in your .env file`);
                logger.warning(`   💾 File retained locally: ${filePath}`);
                logger.info(`   ⚠️  User ${username} connection kept active for retry after configuration`);
                return;
            }
            
            try {
                const uploadResult = await egnyteClient.uploadFile(filePath, egnyteDestinationPath);
                
                // Only delete local file after successful upload
                try {
                    fs.unlinkSync(filePath);
                    logger.success(`🗑️  Local file deleted: ${fileName}`);
                    logger.info(`   ✨ Workflow completed successfully for ${username}`);
                } catch (deleteError) {
                    logger.error(`⚠️  Could not delete local file: ${deleteError.message}`);
                    logger.warning(`   📁 File retained at: ${filePath}`);
                }
                
                // Auto-disconnect user after successful upload
                logger.info(`🔌 Auto-disconnecting ${username} after successful upload`);
                setTimeout(() => {
                    if (activeConnections.has(username)) {
                        connection.close();
                    }
                }, CONFIG.FTP.AUTO_DISCONNECT_DELAY);
                
            } catch (egnyteError) {
                logger.error(`❌ Egnyte upload failed for ${username}`);
                logger.error(`   📁 File: ${fileName}`);
                logger.error(`   🚨 Error: ${egnyteError.message}`);
                logger.warning(`   💾 File retained locally for retry: ${filePath}`);
                logger.info(`   🔄 Manual retry or investigation required`);
                
                // Don't auto-disconnect on error - let user retry or admin investigate
                logger.info(`   ⚠️  User ${username} connection kept active for retry`);
            }
            
        } catch (err) {
            logger.warning('Could not get file stats:', err.message);
        }
    });
    
    // Monitor connection events
    connection.on('close', () => {
        logger.info(`User ${username} disconnected`);
        activeConnections.delete(username);
        clearTimeout(idleTimer);
        logger.info(`Active connections: ${activeConnections.size}/${CONFIG.FTP.MAX_CONNECTIONS}`);
    });
    
    connection.on('error', (error) => {
        logger.error(`Connection error for ${username}: ${error.message}`);
        activeConnections.delete(username);
        clearTimeout(idleTimer);
    });
    
    // Add disconnect handler for idle timeout
    connection.on('end', () => {
        logger.info(`User ${username} connection ended`);
        activeConnections.delete(username);
        clearTimeout(idleTimer);
    });
    
    // Reset idle timer on other FTP commands
    ['RETR', 'DELE', 'MKD', 'RMD', 'LIST', 'NLST', 'PWD', 'CWD'].forEach(command => {
        connection.on(command, () => resetIdleTimer());
    });
});

// Start the FTP server
ftpServer.listen().then(() => {
    // Clear any stale connection tracking on startup
    activeConnections.clear();
    
    console.log('\n🚀 Xerox FTP to Egnyte Gateway Started!');
    console.log('=' .repeat(50));
    logger.info('Server URL:', `ftp://${CONFIG.FTP.HOST}:${CONFIG.FTP.PORT}`);
    logger.info('Max concurrent connections:', CONFIG.FTP.MAX_CONNECTIONS);
    logger.info('Idle timeout:', `${CONFIG.FTP.IDLE_TIMEOUT / 1000} seconds`);
    logger.info('Egnyte domain:', CONFIG.EGNYTE.DOMAIN);
    logger.info('Valid users:', Object.keys(userMappings).join(', '));
    
    console.log('\n📋 Ready for scanner connections!');
    console.log('🛑 Press Ctrl+C to stop the server\n');
    
}).catch(error => {
    logger.error('Failed to start FTP server:', error.message);
    if (error.code === 'EADDRINUSE') {
        logger.error(`Port ${CONFIG.FTP.PORT} is already in use`);
    }
    if (error.code === 'EACCES') {
        logger.error('Permission denied. Try running as administrator.');
    }
    process.exit(1);
});

// Handle server errors
ftpServer.on('error', (error) => {
    logger.error('FTP Server Error:', error.message);
});

// Periodic cleanup of stale connections
setInterval(() => {
    const beforeSize = activeConnections.size;
    for (const [user, connInfo] of activeConnections.entries()) {
        if (connInfo.connection.destroyed || connInfo.connection.readyState === 'closed') {
            logger.warning(`Periodic cleanup: Removing stale connection for ${user}`);
            activeConnections.delete(user);
        }
    }
    const afterSize = activeConnections.size;
    if (beforeSize !== afterSize) {
        logger.info(`Connection cleanup: ${beforeSize} → ${afterSize} active connections`);
    }
}, 30000); // Check every 30 seconds

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down FTP server...');
    
    // Close all active connections
    activeConnections.forEach((connInfo, username) => {
        logger.info(`Closing connection for ${username}`);
        try {
            connInfo.connection.close();
        } catch (err) {
            // Ignore errors during shutdown
        }
    });
    
    ftpServer.close(() => {
        logger.success('FTP server stopped');
        process.exit(0);
    });
});

// Export configuration for external access
module.exports = { CONFIG, logger };