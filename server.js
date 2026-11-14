const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.json());
app.use(express.static('./'));

const tmpDir = path.join(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

let storedKey = null;

app.post('/api/key', (req, res) => {
    const { apiKey } = req.body;
    if (!apiKey) return res.status(400).json({ error: 'Key required' });
    storedKey = apiKey; 
    res.json({ success: true, message: 'Key linked' });
});

app.post('/api/process', async (req, res) => {
    const { url, targetType, targetId } = req.body;
    if (!storedKey) return res.status(401).json({ error: 'No API key linked' });
    
    const jobId = crypto.randomUUID();
    const jobDir = path.join(tmpDir, jobId);
    fs.mkdirSync(jobDir);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendEvent = (step, status, data = {}) => {
        res.write(`data: ${JSON.stringify({ step, status, ...data })}\n\n`);
    };

    try {
        sendEvent('download', 'active');
        // Uses the yt-dlp.exe in your folder
        const ytdlp = spawn('./yt-dlp.exe', ['-x', '--audio-format', 'mp3', '-o', path.join(jobDir, 'raw.%(ext)s'), url]);
        
        ytdlp.on('close', (code) => {
            if (code !== 0) return sendEvent('error', 'failed', { message: 'Download failed' });

            sendEvent('download', 'complete');
            sendEvent('convert', 'active');

            const rawFile = path.join(jobDir, 'raw.mp3');
            // Uses the ffmpeg.exe in your folder
            const ffmpeg = spawn('./ffmpeg.exe', [
                '-i', rawFile,
                '-af', 'atempo=1.05,volume=2dB',
                '-f', 'segment',
                '-segment_time', '420',
                '-reset_timestamps', '1',
                path.join(jobDir, 'part_%03d.mp3')
            ]);

            ffmpeg.on('close', async (ffCode) => {
                if (ffCode !== 0) return sendEvent('error', 'failed', { message: 'Processing failed' });

                sendEvent('convert', 'complete');
                sendEvent('upload', 'active');

                try {
                    const files = fs.readdirSync(jobDir).filter(f => f.startsWith('part_'));
                    let uploadedAssets = [];

                    for (let i = 0; i < files.length; i++) {
                        const filePath = path.join(jobDir, files[i]);
                        const form = new FormData();
                        form.append('file', fs.createReadStream(filePath));
                        form.append('assetType', 'Audio');
                        form.append('displayName', `CENZ Upload Part ${i+1}`);
                        
                        const creatorJson = targetType === 'group' 
                            ? JSON.stringify({ groupId: targetId })
                            : JSON.stringify({ userId: targetId });
                            
                        form.append('creationContext', `{"creator": ${creatorJson}}`);

                        const response = await axios.post('https://apis.roblox.com/assets/v1/assets', form, {
                            headers: { ...form.getHeaders(), 'x-api-key': storedKey }
                        });

                        const operationId = response.data.operationId;
                        let assetId = null;
                        
                        while (!assetId) {
                            await new Promise(r => setTimeout(r, 2000));
                            const opRes = await axios.get(`https://apis.roblox.com/assets/v1/operations/${operationId}`, {
                                headers: { 'x-api-key': storedKey }
                            });
                            if (opRes.data.done) {
                                if (opRes.data.error) throw new Error(JSON.stringify(opRes.data.error));
                                assetId = opRes.data.response.assetId;
                            }
                        }
                        uploadedAssets.push(`rbxassetid://${assetId}`);
                    }

                    sendEvent('upload', 'complete');
                    sendEvent('moderation', 'active');

                    setTimeout(() => {
                        sendEvent('moderation', 'complete', { 
                            assetId: uploadedAssets[0], 
                            target: targetId 
                        });
                        res.end();
                        fs.rmSync(jobDir, { recursive: true, force: true });
                    }, 2000);

                } catch (err) {
                    const errorMsg = err.response ? JSON.stringify(err.response.data) : err.message;
                    sendEvent('error', 'failed', { message: 'Roblox Error: ' + errorMsg });
                    res.end();
                }
            });
        });
    } catch (err) {
        sendEvent('error', 'failed', { message: err.message });
        res.end();
    }
});

app.listen(3000, () => console.log('Server running. Open http://localhost:3000'));