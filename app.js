const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const simpleGit = require('simple-git');
const { exec, spawn } = require('child_process');
const http = require('http');
const socketIo = require('socket.io');
const portfinder = require('portfinder');
const httpProxy = require('http-proxy');
const { v4: uuidv4 } = require('uuid');

// Function to get the VM's IP address
function getVmIpAddress() {
    const networkInterfaces = os.networkInterfaces();
    const ipAddress = Object.values(networkInterfaces)
        .flat()
        .find(iface => iface.family === 'IPv4' && !iface.internal);
    return ipAddress ? ipAddress.address : 'localhost';
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Store deployed apps information
const deployedApps = {};
// For storing cleanup timers
const appTimers = {};
// Default inactivity timeout (30 minutes)
const INACTIVITY_TIMEOUT = 30 * 60 * 1000;
// Base directory for storing repositories
const REPOS_DIR = path.join(__dirname, 'repos');

// Ensure repos directory exists
fs.ensureDirSync(REPOS_DIR);

// Middleware to parse JSON requests
app.use(express.json());

// Serve static files from the root directory
app.use(express.static(__dirname));

// WebSocket connection
io.on('connection', (socket) => {
    console.log('Client connected');
    
    // Handle joining deployment rooms for log streaming
    socket.on('join', (room) => {
        socket.join(room);
        console.log(`Client joined room: ${room}`);
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

// Utility to create a unique deployment ID
function createDeploymentId() {
    return uuidv4().substring(0, 8);
}

// Utility to check if a repository is a Node.js project
function isNodeJsProject(repoPath) {
    return fs.existsSync(path.join(repoPath, 'package.json'));
}

// Setup proxy server for forwarding requests to deployed apps
const proxy = httpProxy.createProxyServer({});

// Handle proxy errors
proxy.on('error', (err, req, res) => {
    console.error('Proxy error:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Proxy error occurred');
});

// Route for proxying requests to deployed apps
app.use('/app/:id', (req, res) => {
    const appId = req.params.id;
    const deployedApp = deployedApps[appId];
    
    if (!deployedApp || !deployedApp.port) {
        return res.status(404).send('App not found or not running');
    }
    
    // Reset inactivity timer when app is accessed
    resetInactivityTimer(appId);
    
    // Forward the request to the deployed app
    proxy.web(req, res, { target: `http://localhost:${deployedApp.port}` });
});

// Reset inactivity timer for an app
function resetInactivityTimer(appId) {
    const app = deployedApps[appId];
    if (!app) return;
    
    // Clear existing timer if any
    if (appTimers[appId]) {
        clearTimeout(appTimers[appId]);
    }
    
    // Set new timer
    appTimers[appId] = setTimeout(() => {
        cleanupDeployment(appId);
    }, INACTIVITY_TIMEOUT);
}

// Cleanup a deployment
async function cleanupDeployment(id) {
    const app = deployedApps[id];
    if (!app) return false;
    
    console.log(`Cleaning up deployment: ${id}`);
    
    // Kill the process if it exists
    if (app.process) {
        try {
            process.kill(-app.process.pid); // Kill process group
        } catch (error) {
            console.log(`Error killing process for ${id}:`, error);
        }
    }
    
    // Remove the deployment from our tracking
    delete deployedApps[id];
    
    // Clear the timer
    if (appTimers[id]) {
        clearTimeout(appTimers[id]);
        delete appTimers[id];
    }
    
    // Try to remove the repo directory
    try {
        await fs.remove(app.path);
        console.log(`Removed repository directory for ${id}`);
    } catch (error) {
        console.log(`Error removing repository for ${id}:`, error);
    }
    
    return true;
}

// Deploy endpoint for GitHub repo URL
app.post('/deploy', async (req, res) => {
    const { repoUrl } = req.body;
    
    if (!repoUrl) {
        return res.status(400).json({ error: 'GitHub repository URL is required' });
    }
    
    // Validate GitHub URL format
    const githubUrlPattern = /^https?:\/\/(www\.)?github\.com\/[^\/]+\/[^\/]+/;
    if (!githubUrlPattern.test(repoUrl)) {
        return res.status(400).json({ error: 'Invalid GitHub repository URL' });
    }
    
    // Generate a unique ID for this deployment
    const deploymentId = createDeploymentId();
    // Create a unique folder for this repo
    const repoDir = path.join(REPOS_DIR, deploymentId);
    
    console.log(`Starting deployment ${deploymentId} for repo: ${repoUrl}`);
    
    // Create initial response
    res.json({
        deploymentId,
        message: 'Deployment started',
        status: 'initializing'
    });
    
    // Begin deployment process
    try {
        // Create repository directory
        await fs.ensureDir(repoDir);
        
        // Initialize deployment record
        deployedApps[deploymentId] = {
            id: deploymentId,
            repoUrl,
            path: repoDir,
            status: 'cloning',
            createdAt: new Date()
        };
        
        // Set up socket room for this deployment
        const deploymentRoom = `deployment-${deploymentId}`;
        
        // Clone the repository
        const git = simpleGit();
        
        io.to(deploymentRoom).emit('log', { message: `Cloning repository: ${repoUrl}` });
        
        git.clone(repoUrl, repoDir, ['--depth', '1'], (err) => {
            if (err) {
                io.to(deploymentRoom).emit('log', { 
                    message: `Error cloning repository: ${err.message}`,
                    type: 'error'
                });
                deployedApps[deploymentId].status = 'failed';
                return;
            }
            
            io.to(deploymentRoom).emit('log', { 
                message: 'Repository cloned successfully',
                type: 'success'
            });
            
            deployedApps[deploymentId].status = 'preparing';
            
            // Determine if it's a Node.js project
            const isNode = isNodeJsProject(repoDir);
            deployedApps[deploymentId].type = isNode ? 'nodejs' : 'static';
            
            // Find an available port
            portfinder.getPort({ startPort: 8080 }, async (err, port) => {
                if (err) {
                    io.to(deploymentRoom).emit('log', { 
                        message: `Error finding available port: ${err.message}`,
                        type: 'error'
                    });
                    deployedApps[deploymentId].status = 'failed';
                    return;
                }
                
                deployedApps[deploymentId].port = port;
                
                if (isNode) {
                    // It's a Node.js project - install dependencies
                    io.to(deploymentRoom).emit('log', { message: 'Installing dependencies...' });
                    
                    const npm = spawn('npm', ['install'], {
                        cwd: repoDir,
                        shell: true,
                        detached: true
                    });
                    
                    npm.stdout.on('data', (data) => {
                        io.to(deploymentRoom).emit('log', { 
                            message: data.toString(),
                            type: 'stdout'
                        });
                    });
                    
                    npm.stderr.on('data', (data) => {
                        io.to(deploymentRoom).emit('log', { 
                            message: data.toString(),
                            type: 'stderr'
                        });
                    });
                    
                    npm.on('close', (code) => {
                        if (code !== 0) {
                            io.to(deploymentRoom).emit('log', { 
                                message: `npm install exited with code ${code}`,
                                type: 'error'
                            });
                            deployedApps[deploymentId].status = 'failed';
                            return;
                        }
                        
                        io.to(deploymentRoom).emit('log', { 
                            message: 'Dependencies installed successfully',
                            type: 'success'
                        });
                        
                        // Always use npm start for Node.js applications
                        const startCommand = 'npm start';
                        io.to(deploymentRoom).emit('log', { 
                            message: `Starting application with: ${startCommand}`,
                            type: 'info'
                        });
                        
                        // Set PORT environment variable for the app
                        const env = { ...process.env, PORT: port };
                        
                        const nodeApp = spawn(startCommand, [], {
                            cwd: repoDir,
                            shell: true,
                            detached: true,
                            env
                        });
                        
                        deployedApps[deploymentId].process = nodeApp;
                        deployedApps[deploymentId].status = 'running';
                        
                        nodeApp.stdout.on('data', (data) => {
                            io.to(deploymentRoom).emit('log', { 
                                message: data.toString(),
                                type: 'stdout'
                            });
                        });
                        
                        nodeApp.stderr.on('data', (data) => {
                            io.to(deploymentRoom).emit('log', { 
                                message: data.toString(),
                                type: 'stderr'
                            });
                        });
                        
                        nodeApp.on('close', (code) => {
                            io.to(deploymentRoom).emit('log', { 
                                message: `Application exited with code ${code}`,
                                type: code === 0 ? 'info' : 'error'
                            });
                            
                            deployedApps[deploymentId].status = 'stopped';
                        });
                        
                        // Setup access URL
                        const hostname = getVmIpAddress();
                        const accessUrl = `http://${hostname}:${port}/`;
                        deployedApps[deploymentId].url = accessUrl;
                        
                        io.to(deploymentRoom).emit('status', { 
                            status: 'running',
                            url: accessUrl,
                            port,
                            type: 'nodejs'
                        });
                        
                        // Set inactivity timer
                        resetInactivityTimer(deploymentId);
                    });
                } else {
                    // It's a static site - serve with Express
                    // Create a new Express app for serving static files
                    const staticApp = express();
                    staticApp.use(express.static(repoDir));
                    
                    // Start the static server
                    const staticServer = staticApp.listen(port, () => {
                        io.to(deploymentRoom).emit('log', { 
                            message: `Static site server started on port ${port}`,
                            type: 'success'
                        });
                        
                        deployedApps[deploymentId].server = staticServer;
                        deployedApps[deploymentId].status = 'running';
                        
                        // Setup access URL
                        const hostname = getVmIpAddress();
                        const accessUrl = `http://${hostname}:${port}/`;
                        deployedApps[deploymentId].url = accessUrl;
                        
                        io.to(deploymentRoom).emit('status', { 
                            status: 'running',
                            url: accessUrl,
                            port,
                            type: 'static'
                        });
                        
                        // Set inactivity timer
                        resetInactivityTimer(deploymentId);
                    });
                }
            });
        });
        
    } catch (error) {
        console.error('Deployment error:', error);
        io.to(`deployment-${deploymentId}`).emit('log', { 
            message: `Deployment error: ${error.message}`,
            type: 'error'
        });
        
        deployedApps[deploymentId].status = 'failed';
        deployedApps[deploymentId].error = error.message;
    }
});

// Get deployment status and info
app.get('/status/:id', (req, res) => {
    const { id } = req.params;
    const app = deployedApps[id];
    
    if (!app) {
        return res.status(404).json({ error: 'Deployment not found' });
    }
    
    // Reset inactivity timer
    resetInactivityTimer(id);
    
    res.json({
        id: app.id,
        status: app.status,
        type: app.type,
        url: app.url,
        createdAt: app.createdAt,
        repoUrl: app.repoUrl
    });
});

// List all active deployments
app.get('/deployments', (req, res) => {
    const deployments = Object.values(deployedApps).map(app => ({
        id: app.id,
        status: app.status,
        type: app.type,
        url: app.url,
        createdAt: app.createdAt,
        repoUrl: app.repoUrl
    }));
    
    res.json(deployments);
});

// Manually cleanup/stop a deployment
app.delete('/cleanup/:id', async (req, res) => {
    const { id } = req.params;
    
    const success = await cleanupDeployment(id);
    
    if (success) {
        res.json({ message: `Deployment ${id} has been cleaned up` });
    } else {
        res.status(404).json({ error: `Deployment ${id} not found` });
    }
});

// Configure WebSocket endpoint for logs
app.get('/logs/:id', (req, res) => {
    const { id } = req.params;
    const app = deployedApps[id];
    
    if (!app) {
        return res.status(404).json({ error: 'Deployment not found' });
    }
    
    res.json({
        deploymentId: id,
        socketRoom: `deployment-${id}`
    });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    const vmIp = getVmIpAddress();
    console.log(`Server is running on http://${vmIp}:${PORT}`);
});