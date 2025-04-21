const express = require('express');
const multer = require('multer');
const path = require('path');
const Docker = require('dockerode');
const os = require('os');

// Function to get the VM's IP address
function getVmIpAddress() {
    const networkInterfaces = os.networkInterfaces();
    const ipAddress = Object.values(networkInterfaces)
        .flat()
        .find(iface => iface.family === 'IPv4' && !iface.internal);
    return ipAddress ? ipAddress.address : 'localhost';
}

const app = express();
const docker = new Docker(); // Connect to the default Docker socket

// Middleware to parse JSON requests
app.use(express.json());

// Configure multer for file upload
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname);
    }
});

const upload = multer({ storage: storage });

// Serve static files from the root directory
app.use(express.static(__dirname));

// Upload endpoint
app.post('/upload', upload.single('dockerImage'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }
    res.send({
        message: 'File uploaded successfully',
        filename: req.file.originalname
    });
});

// Deploy endpoint for Docker image reference
app.post('/deploy', async (req, res) => {
    const { imageRef } = req.body;
    
    if (!imageRef) {
        return res.status(400).json({ error: 'Docker image reference is required' });
    }
    
    console.log(`Received Docker image reference: ${imageRef}`);
    
    try {
        // First check if Docker daemon is accessible
        try {
            await docker.ping();
        } catch (dockerErr) {
            if (dockerErr.code === 'EACCES') {
                return res.status(500).json({
                    error: 'Docker permission error',
                    details: 'Unable to access Docker. Please make sure Docker is running and you have the necessary permissions.',
                    code: 'EACCES'
                });
            }
            throw dockerErr;
        }

        // Create a stream to track the pull progress
        try {
            const stream = await docker.pull(imageRef);
            
            // Process the stream to track progress
            docker.modem.followProgress(stream, onFinished, onProgress);
            
            // Handle each progress update
            function onProgress(event) {
                console.log(`Pull progress: ${JSON.stringify(event)}`);
            }
            
            // Handle completion of the pull
            async function onFinished(err, output) {
                if (err) {
                    console.error('Error pulling image:', err);
                    let errorMessage = 'Failed to pull the Docker image';
                    if (err.message.includes('not found')) {
                        return res.status(404).json({
                            error: 'Image not found',
                            details: `The image "${imageRef}" was not found on Docker Hub`
                        });
                    }
                    return res.status(500).json({ 
                        error: errorMessage,
                        details: err.message
                    });
                }
                
                console.log(`Successfully pulled Docker image: ${imageRef}`);
                
                try {
                    // Generate a unique port for this container
                    const hostPort = Math.floor(Math.random() * (65535 - 49152)) + 49152;
                    // Create a sanitized container name from the image reference
                    const containerName = `app-${imageRef.replace(/[\/:\.]*/g, '-')}-${Date.now()}`;
                    
                    // Create the container with resource limits and port mapping
                    const container = await docker.createContainer({
                        Image: imageRef,
                        name: containerName,
                        HostConfig: {
                            PortBindings: {
                                '80/tcp': [{ HostPort: hostPort.toString() }]
                            },
                            Memory: 128 * 1024 * 1024, // 128MB RAM limit
                            NanoCPUs: 1000000000, // 1 CPU core limit (in nanoseconds)
                            RestartPolicy: {
                                Name: 'on-failure',
                                MaximumRetryCount: 3
                            }
                        },
                        ExposedPorts: {
                            '80/tcp': {}
                        }
                    });
                    
                    // Start the container
                    await container.start();
                    console.log(`Container ${containerName} started on port ${hostPort}`);
                    
                    // Get the VM's actual IP address
                    const hostname = getVmIpAddress();
                    
                    res.json({
                        message: `Successfully deployed Docker image: ${imageRef}`,
                        containerName: containerName,
                        url: `http://${hostname}:${hostPort}/`,
                        details: {
                            image: imageRef,
                            port: hostPort,
                            ip: hostname,
                            resources: {
                                memory: '128MB',
                                cpu: '1 core'
                            }
                        }
                    });
                } catch (containerError) {
                    console.error('Error creating/starting container:', containerError);
                    res.status(500).json({ 
                        error: 'Failed to deploy the container',
                        details: containerError.message
                    });
                }
            }
        } catch (pullError) {
            console.error('Error pulling Docker image:', pullError);
            res.status(500).json({
                error: 'Failed to pull the Docker image',
                details: pullError.message
            });
        }
    } catch (error) {
        console.error('Error processing Docker image:', error);
        res.status(500).json({ 
            error: 'Failed to process the Docker image',
            details: error.message
        });
    }
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    const vmIp = getVmIpAddress();
    console.log(`Server is running on http://${vmIp}:${PORT}`);
});