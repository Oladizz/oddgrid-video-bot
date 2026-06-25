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

// Set up the bot token from the environment variable (Render Secrets)
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// The independent webhook endpoint for Telegram
app.post('/webhook', async (req, res) => {
    // Acknowledge Telegram immediately so it doesn't retry
    res.send('OK');

    if (!BOT_TOKEN) {
        console.error("CRITICAL: TELEGRAM_BOT_TOKEN is not set in the environment variables!");
        return;
    }

    try {
        const message = req.body?.message;
        if (!message || !message.video) return;

        const chatId = message.chat.id;
        const fileId = message.video.file_id;
        
        // Parse requested frames from caption (e.g. "5" or "12")
        let requestedFrames = 5; // Default
        if (message.caption) {
            const match = message.caption.match(/(\d+)/);
            if (match) {
                const parsed = parseInt(match[1], 10);
                if (parsed > 0 && parsed <= 60) requestedFrames = parsed;
            }
        }

        // Notify user we received it directly
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: `⚙️ Video Received by Independent Bot!\n\nAutomatically extracting ${requestedFrames} frames. This might take a moment...`
            })
        });

        // Setup temporary directory
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oddgrid-video-'));
        const vidPath = path.join(tmpDir, 'video.mp4');

        try {
            // 1. Get file path from Telegram
            const fileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
            const fileData = await fileRes.json();
            
            if (!fileData.ok) {
                throw new Error(`Cannot get file info: ${fileData.description || 'Unknown Telegram API Error'}`);
            }
            
            const filePath = fileData.result.file_path;
            const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
            
            // 2. Download video
            const vidReq = await fetch(downloadUrl);
            if (!vidReq.ok) throw new Error('Failed to download video file from Telegram');
            const buffer = await vidReq.arrayBuffer();
            fs.writeFileSync(vidPath, Buffer.from(buffer));
            
            // 3. Run ffmpeg
            const { stdout: durOut } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${vidPath}"`);
            const duration = parseFloat(durOut.trim());
            const fps = requestedFrames / duration;
            
            await execAsync(`ffmpeg -i "${vidPath}" -vf fps=${fps} "${tmpDir}/frame_%03d.jpg"`);
            
            const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('frame_')).sort();
            const framesToSend = files.slice(0, requestedFrames);

            // Send each frame back to Telegram
            for (const frameFile of framesToSend) {
                const formData = new FormData();
                formData.append('chat_id', chatId);
                
                const frameData = fs.readFileSync(path.join(tmpDir, frameFile));
                const blob = new Blob([frameData], { type: 'image/jpeg' });
                formData.append('photo', blob, frameFile);

                await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
                    method: 'POST',
                    body: formData
                });
            }

        } catch (err) {
            console.error("Frame extraction error:", err);
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: `❌ Failed to extract frames: ${err.message}`
                })
            });
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    } catch (e) {
        console.error("Critical Webhook Error:", e);
    }
});

// Health check endpoint
app.get('/health', (req, res) => res.json({ status: 'ok', ffmpeg: 'ready' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Video Bot Extraction Backend running on port ${PORT}`);
});
