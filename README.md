# Xerox FTP to Egnyte Gateway

A Node.js application that acts as a gateway between Xerox scanners (using FTP protocol) and Egnyte cloud storage. This service allows users to scan documents directly from Xerox multifunction devices to their personal folders in Egnyte.

## Features

- **FTP Server**: Accepts connections from Xerox scanners
- **User Authentication**: Validates users against configured credentials
- **Automatic Uploads**: Transfers scanned files to user-specific Egnyte folders
- **Batch Processing**: Queues uploads and processes them with configurable delays
- **Logging**: Comprehensive logging of all operations

## Requirements

- Node.js 14.x or higher
- Egnyte account with API access
- Xerox scanner configured for FTP scanning

## Installation

1. Clone the repository:
   ```
   git clone https://github.com/yourusername/xerox-ftp-egnyte-gateway.git
   cd xerox-ftp-egnyte-gateway
   ```

2. Install dependencies:
   ```
   pnpm install
   ```

3. Create a `.env` file in the root directory with the following variables:
   ```
   FTP_PORT=2121
   FTP_HOST=0.0.0.0
   EGNYTE_API_TOKEN=your_egnyte_api_token
   EGNYTE_DOMAIN=your-domain.egnyte.com
   ```

4. Configure user mappings in `config/user-mapping.json`:
   ```json
   {
     "username": {
       "email": "user@example.com",
       "password": "password",
       "egnytePath": "Shared/Userfiles/username/MyScans"
     }
   }
   ```

## Usage

Start the server:

```
node xerox-ftp-egnyte-gateway.js
```

The server will start on the configured port (default: 2121) and begin accepting connections from Xerox scanners.

## Xerox Scanner Configuration

1. On your Xerox device, navigate to the scan settings
2. Configure a new scan destination with the following settings:
   - Protocol: FTP
   - Server Address: IP address of this gateway
   - Port: 2121 (or your configured port)
   - Username: User's username from user-mapping.json
   - Password: User's password from user-mapping.json
   - Directory Path: / (root)

## Monitoring

The application logs all activities to `gateway.log` in the root directory. You can monitor this file for troubleshooting and auditing purposes.

## Security Considerations

- It's recommended to change the default passwords in the user mapping file
- Consider running the server behind a firewall that only allows connections from your Xerox devices
- Regularly rotate your Egnyte API token

## License

[MIT](LICENSE)
