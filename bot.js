const { Client, LocalAuth } = require('whatsapp-web.js')
const express = require('express')
const QRCode = require('qrcode')
const waVersion = require('@wppconnect/wa-version')
const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')
const YTMusic = require('ytmusic-api')

const app = express()
const PORT = 3000

let qrCodeData = null

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    },
    webVersionCache: {
        type: 'remote',
        remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${waVersion.getLatestVersion()}.html`
    }
})

const ytmusic = new YTMusic()

client.on('qr', async (qr) => {
    console.log('📱 QR Received, open ur browser')
    qrCodeData = await QRCode.toDataURL(qr)
})

client.on('ready', () => {
    console.log('✅ Bot siap!')
    qrCodeData = null
})
client.on('authenticated', () => console.log('✅ Login berhasil!'))
client.on('auth_failure', msg => console.error('❌ Auth gagal:', msg))
client.on('disconnected', reason => console.log('⚠️ Disconnect:', reason))

app.get('/', (req, res) => {
    if (qrCodeData) {
        res.send(`
<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<title>WhatsApp Bot</title>
<style>
    body {
        margin: 0;
        padding: 0;
        background: #0f172a;
        color: #e2e8f0;
        font-family: Arial, sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
    }

    .container {
        text-align: center;
        background: #1e293b;
        padding: 30px;
        border-radius: 16px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.4);
    }

    h2 {
        margin-bottom: 20px;
    }

    img {
        width: 250px;
        border-radius: 12px;
        background: white;
        padding: 10px;
    }

    .status {
        margin-top: 15px;
        font-size: 14px;
        opacity: 0.7;
    }
</style>
</head>
<body>

<div class="container">
    ${
        qrCodeData
        ? `
            <h2>📱 Scan QR WhatsApp</h2>
            <img src="${qrCodeData}" />
            <div class="status">Scan pakai WhatsApp kamu</div>
        `
        : `
            <h2>✅ Bot sudah login</h2>
            <div class="status">Silakan gunakan bot di WhatsApp</div>
        `
    }
</div>

</body>
</html>
        `)
    } else { 
        res.send(`
<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<title>WhatsApp Bot</title>
<style>
    body {
        margin: 0;
        padding: 0;
        background: #0f172a;
        color: #e2e8f0;
        font-family: Arial, sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
    }

    .container {
        text-align: center;
        background: #1e293b;
        padding: 30px;
        border-radius: 16px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.4);
    }

    h2 {
        margin-bottom: 10px;
    }

    .status {
        margin-top: 10px;
        font-size: 14px;
        opacity: 0.7;
    }

    .check {
        font-size: 50px;
        margin-bottom: 10px;
    }
</style>
</head>
<body>

<div class="container">
    <div class="check">✅</div>
    <h2>Bot sudah login</h2>
    <div class="status">Silakan gunakan bot di WhatsApp</div>
</div>

</body>
</html>
        `)
    }
})

app.listen(PORT, () => {
    console.log(`🌐 http://localhost:${PORT}`)
})

let cooldownDB = {
    chat: {},
    command: {}
}
if (fs.existsSync('./cooldown.json')) {
    cooldownDB = JSON.parse(fs.readFileSync('./cooldown.json'))
}
function saveCooldown() {
    fs.writeFileSync('./cooldown.json', JSON.stringify(cooldownDB, null, 2))
}
function isOnCooldown(type, user, duration) {
    const now = Date.now()
    const last = cooldownDB[type][user]

    if (!last) return false

    return (now - last) < duration
}
function setCooldown(type, user) {
    cooldownDB[type][user] = Date.now()
    saveCooldown()
}
function cleanupCooldown() {
    const now = Date.now()

    for (const type in cooldownDB) {
        for (const user in cooldownDB[type]) {
            const limit = type === 'command' ? COMMAND_COOLDOWN : CHAT_COOLDOWN

            if (now - cooldownDB[type][user] > limit) {
                delete cooldownDB[type][user]
            }
        }
    }

    saveCooldown()
}
setInterval(cleanupCooldown, 5 * 60 * 1000)

const CHAT_COOLDOWN = 8 * 60 * 1000
const COMMAND_COOLDOWN =  0.75 * 60 * 1000
const prefix = '!'

const getGreeting = () => {
    const hour = new Date().getHours()
    if (hour >= 4 && hour < 10) return "Selamat pagi 🌅"
    if (hour >= 10 && hour < 15) return "Selamat siang ☀️"
    if (hour >= 15 && hour < 18) return "Selamat sore 🌇"
    return "Selamat malam 🌙"
}

async function startBot() {
    await ytmusic.initialize()
    console.log('🎵 YTMusic siap!')

    // main handler
    async function handleMessage(msg) {
        try {
            if (msg.from === 'status@broadcast') return
            if (!msg.body || typeof msg.body !== 'string') return

            const text = msg.body || ''

            if (msg.fromMe && !text.startsWith(prefix)) return

            const now = Date.now()
            const isGroup = msg.from.endsWith('@g.us')
            const sender = msg.author || msg.from
            const isCommand = text.startsWith(prefix)

            if (msg.fromMe && msg.id.fromMe === false) return

            if (isCommand) {
                const args = text.slice(1).trim().split(/ +/)
                const command = args.shift().toLowerCase()

                let isAdmin = false

                if (isGroup) {
                    const chat = await msg.getChat()

                    if (chat.isGroup) {
                        const author = msg.author || msg.from
                        const participant = chat.participants.find(p => p.id._serialized === author)

                        isAdmin = participant?.isAdmin || participant?.isSuperAdmin
                    }
                }

                const isOwner = msg.fromMe
                if (!isOwner && !isAdmin) {
                    if (isOnCooldown('command', command, COMMAND_COOLDOWN)) return
                    setCooldown('command', command)
                }

                // menu bot
                if (command === 'help') {
                    msg.reply(`Halo 👋
Ini fitur yang bisa dipakai:

• !play <judul>
• !download <link>
• !sticker

simple aja, tinggal pakai 👍`)
                }

                // cmd play
                if (command === 'play') {
                    const query = args.join(' ')
                    if (!query) return msg.reply('Contoh: ```!play judul lagu```')

                    const results = await ytmusic.searchSongs(query)
                    const song = results[0]

                    if (!song) return msg.reply('❌ Lagu tidak ditemukan')

                    function formatDuration(sec) {
                        if (typeof sec === 'string') return sec

                        const minutes = Math.floor(sec / 60)
                        const seconds = sec % 60

                        return `${minutes}:${seconds.toString().padStart(2, '0')}`
                    }

                    const title = song.name
                    const artist = song.artist?.name || 'Unknown'
                    const duration = song.duration
                        ? formatDuration(song.duration)
                        : 'Unknown'
                    const videoUrl = `https://www.youtube.com/watch?v=${song.videoId}`

                    await msg.reply(`🎶 *NOW PLAYING*

📌 *Title*      : ${title}
👤 *Artist*     : ${artist}
⏱️ *Duration*   : ${duration}
`)

                    const filePath = path.join(__dirname, `${Date.now()}.mp3`)
                    const cmd = `yt-dlp -x --audio-format mp3 -o "${filePath}" "${videoUrl}"`

                    exec(cmd, async (err) => {
                        if (err) {
                            console.error(err)

                            const fallback = `python -m yt_dlp -x --audio-format mp3 -o "${filePath}" "${videoUrl}"`

                            exec(fallback, async (err2) => {
                                if (err2) {
                                    console.error(err2)
                                    return msg.reply('❌ Gagal download audio')
                                }
                                setTimeout(sendAudio, 1500)
                            })
                            return
                        }

                        setTimeout(sendAudio, 1500)
                    })

                    const { MessageMedia } = require('whatsapp-web.js')
                    async function sendAudio() {
                        try {
                            if (!fs.existsSync(filePath)) {
                                return msg.reply('❌ File audio tidak ditemukan')
                            }

                            const media = MessageMedia.fromFilePath(filePath)
                            const chatId = msg.fromMe ? msg.to : msg.from

                            await msg.reply(media, undefined, {
                                sendAudioAsVoice: false,
                                mimetype: 'audio/mpeg'
                            })

                            console.log('✅ Audio terkirim')
                        } catch (e) {
                            console.error(e)
                            msg.reply('❌ Gagal kirim audio')
                        } finally {
                            if (fs.existsSync(filePath)) {
                                fs.unlinkSync(filePath)
                                console.log('🗑️ File dihapus')
                            }
                        }
                    }
                }

                // cmd stiker
                if (command === 'sticker') {
                    let mediaMsg = msg
                    if (msg.hasQuotedMsg) {
                        mediaMsg = await msg.getQuotedMessage()
                    }
                    if (!mediaMsg.hasMedia) {
                        return msg.reply('Reply / kirim gambarmu dengan ```!sticker```')
                    }

                    try {
                        const media = await mediaMsg.downloadMedia()

                        if (!media) {
                            return msg.reply('❌ Gagal download media')
                        }
                        await msg.reply(media, undefined, {
                            sendMediaAsSticker: true
                        })
                    } catch (err) {
                        console.error(err)
                        msg.reply('❌ Gagal membuat sticker')
                    }
                }

                // cmd download konten
                if (command === 'download') {
                    const url = args[0]

                    if (!url) {
                        return msg.reply('Contoh: ```!download <link>```')
                    }

                    await msg.reply('⏳ Sedang download...')

                    const fileId = Date.now()
                    const output = path.join(__dirname, `${fileId}.%(ext)s`)

                    const cmd = `yt-dlp -f "mp4/best" -o "${output}" "${url}"`

                    exec(cmd, async (err) => {
                        if (err) {
                            console.error(err)
                            return msg.reply('❌ Gagal download konten')
                        }

                        try {
                            const files = fs.readdirSync(__dirname)
                            const fileName = files.find(f => f.startsWith(fileId.toString()))

                            if (!fileName) {
                                return msg.reply('❌ File tidak ditemukan')
                            }

                            const fullPath = path.join(__dirname, fileName)

                            await new Promise(r => setTimeout(r, 1000))

                            const stats = fs.statSync(fullPath)

                            if (stats.size > 16 * 1024 * 1024) {
                                fs.unlinkSync(fullPath)
                                return msg.reply('❌ File terlalu besar (max ±16MB)')
                            }

                            const { MessageMedia } = require('whatsapp-web.js')
                            const media = MessageMedia.fromFilePath(fullPath)

                            await msg.reply(media, undefined, {
                                caption: '🎬 Berhasil di-download'
                            })

                            console.log('✅ Video terkirim')

                            if (fs.existsSync(fullPath)) {
                                fs.unlinkSync(fullPath)
                                console.log('🗑️ File dihapus')
                            }

                        } catch (e) {
                            console.error(e)
                            msg.reply('❌ Gagal kirim media')
                        }
                    })
                }
                return
            }

            // auto-reply private
            if (!isCommand && !isGroup && !msg.fromMe) {
                if (isOnCooldown('chat', sender, CHAT_COOLDOWN)) return
                setCooldown('chat', sender)

                await msg.reply(`Halo ${getGreeting()}! \n\nTulis pesanmu dibawah ya...😊`)
            }

        } catch (err) {
            console.error('❌ Error:', err)
        }
    }

    client.on('message', handleMessage)
    client.on('message_create', handleMessage)

    client.on('group_join', async (notification) => {
        try {
            const chat = await notification.getChat();
            if (!chat.isGroup) return;

            // 🔒 cek apakah bot admin
            const me = chat.participants.find(p => p.isMe);
            if (!me || !me.isAdmin) return;

            const user = notification.id.participant || notification.id.remote;
            if (!user) return;
            if (user === client.info.wid._serialized) return;

            const text = `👋 Halo @${user.split('@')[0]}!

Welcome di *${chat.name}* 🎉  
Semoga betah ya di sini 😆

📌 Jangan lupa baca rules dulu ya biar gak salah langkah 👀

Enjoy! 🚀`;

            await chat.sendMessage(text, {
                mentions: [user]
            });

        } catch (err) {
            console.log('Error welcome:', err);
        }
    });


    client.on('group_leave', async (notification) => {
        try {
            const chat = await notification.getChat();
            if (!chat.isGroup) return;

            // 🔒 cek apakah bot admin
            const me = chat.participants.find(p => p.isMe);
            if (!me || !me.isAdmin) return;

            const user = notification.id.participant || notification.id.remote;
            if (!user) return;
            if (user === client.info.wid._serialized) return;

            const text = `😢 Yah, @${user.split('@')[0]} keluar nih...

Makasih udah pernah join di *${chat.name}* 🙏  
Semoga kita bisa ketemu lagi di lain waktu 👋

Take care ya! ✨`;

            await chat.sendMessage(text, {
                mentions: [user]
            });

        } catch (err) {
            console.log('Error goodbye:', err);
        }
    });
    client.initialize()
}

startBot()
