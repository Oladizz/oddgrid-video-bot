const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const os = require('os');
const fs = require('fs');

const execAsync = util.promisify(exec);
const app = express();

app.use(cors());
app.use(express.json());

app.post('/api/process-video-frames', async (req, res) => {
    try {
        const { fileId, frames, chatId, botToken } = req.body;
        if (!fileId || !frames || !chatId || !botToken) {
            return res.status(400).json({ error: 'Missing params' });
        }
        
        // Return immediately so the Cloudflare Worker doesn't timeout (30s limit)
        res.json({ success: true, message: 'Processing started' });

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oddgrid-video-'));
        const vidPath = path.join(tmpDir, 'video.mp4');

        try {
            // 1. Get file path from Telegram
            const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
            const fileData = await fileRes.json();
            
            if (!fileData.ok) {
                throw new Error(`Cannot get file info: ${fileData.description || 'Unknown Telegram API Error'}`);
            }
            
            const filePath = fileData.result.file_path;
            const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
            
            // 2. Download video
            const vidReq = await fetch(downloadUrl);
            if (!vidReq.ok) throw new Error('Failed to download video file from Telegram');
            const buffer = await vidReq.arrayBuffer();
            fs.writeFileSync(vidPath, Buffer.from(buffer));
            
            // 3. Run ffmpeg
            // Get duration
            const { stdout: durOut } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${vidPath}"`);
            const duration = parseFloat(durOut.trim());
            const fps = frames / duration;
            
            await execAsync(`ffmpeg -i "${vidPath}" -vf fps=${fps} "${tmpDir}/frame_%03d.jpg"`);
            
            const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('frame_')).sort();
            
            // Limit to requested frames
            const framesToSend = files.slice(0, frames);

            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: `✅ Extraction complete! Sending ${framesToSend.length} frames...`
                })
            });

            // Send each frame
            for (const frameFile of framesToSend) {
                const formData = new FormData();
                formData.append('chat_id', chatId);
                
                const frameData = fs.readFileSync(path.join(tmpDir, frameFile));
                const blob = new Blob([frameData], { type: 'image/jpeg' });
                formData.append('photo', blob, frameFile);

                await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
                    method: 'POST',
                    body: formData
                });
            }

        } catch (err) {
            console.error("Frame extraction error:", err);
            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: `❌ Failed to extract frames: ${err.message}`
                })
            });
        } finally {
            // Clean up temporary files
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    } catch (e) {
        console.error("Critical Express Route Error:", e);
    }
});

// Health check endpoint
app.get('/health', (req, res) => res.json({ status: 'ok', ffmpeg: 'ready' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Video Bot Extraction Backend running on port ${PORT}`);
});
