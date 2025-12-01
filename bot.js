const fs = require('fs')
const path = require('path')
const express = require('express')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const QRCode = require('qrcode')
const { flushCompileCache } = require('module')

const replyCooldown = new Map()
const botStatus = new Map()
const offlineMode = new Map()
const statusFile = path.join(__dirname, 'status.json')

let latestQR = ""
let isConnected = false

function isUserOffline(sessionName) {
    return offlineMode.get(sessionName) ?? true
}

function getSapaan() {
    const now = new Date()
    const jam = now.getHours()
    if (jam >= 4 && jam < 11) return "*Selamat pagi*"
    if (jam >= 11 && jam < 15) return "*Selamat siang*"
    if (jam >= 15 && jam < 18) return "*Selamat sore*"
    return "*Selamat malam*"
}

function loadStatus() {
    if (!fs.existsSync(statusFile)) {
        fs.writeFileSync(statusFile, '{}')
    }
    return JSON.parse(fs.readFileSync(statusFile))
}

function saveStatus(statusObj) {
    fs.writeFileSync(statusFile, JSON.stringify(statusObj, null, 2))
}

function getBotStatus(sessionName) {
    const status = loadStatus()
    return status[sessionName] ?? true
}

function setBotStatus(sessionName, isOnline) {
    const status = loadStatus()
    status[sessionName] = isOnline
    saveStatus(status)
}

function getDefaultAssistantFile(sessionName) {
    return path.join('id', sessionName, 'defaultAssistant.json')
}

function loadDefaultAssistant(sessionName) {
    const filePath = getDefaultAssistantFile(sessionName)
    if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8')
        try {
            const data = JSON.parse(raw)
            return data.assistant || 'Bot'
        } catch (err) {
            console.error(`❌ Error parsing defaultAssistant.json:`, err)
            return 'Bot'
        }
    }
    return 'Bot'
}

function getOwnerCall(sessionName) {
    return path.join('id', sessionName, 'owner.json')
}

function loadOwnerCall(sessionName) {
    const filePath = getOwnerCall(sessionName)
    if (fs.existsSync(filePath)) {
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
            const gender = (data.gender || '').toLowerCase()
            const name = data.owner || 'Pemilik'
            const panggilan = gender === 'female' ? 'Mbak' : 'Mas'
            return `${panggilan} ${name}`
        } catch (err) {
            console.error('❌ Gagal ambil sapaan owner:', err)
            return 'Pemilik'
        }
    }
    return 'Pemilik'
}

function saveOwnerCall(sessionName, name, gender) {
    const filePath = getOwnerCall(sessionName)
    const dirPath = path.dirname(filePath)

    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true })
    }

    let data = {}
    if (fs.existsSync(filePath)) {
        try {
            data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        } catch (err) {
            console.error('❌ Gagal baca owner.json:', err)
        }
    }

    data.owner = name
    if (gender === 'male' || gender === 'female') {
        data.gender = gender
    }

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
}

function saveDefaultAssistant(sessionName, name) {
    const filePath = getDefaultAssistantFile(sessionName)
    const jsonData = { assistant: name }
    fs.writeFileSync(filePath, JSON.stringify(jsonData, null, 2))
}

function getReasonFile(sessionName) {
    return path.join('id', sessionName, 'offlineReason.json')
}

function saveOfflineReason(sessionName, reason) {
    const filePath = getReasonFile(sessionName)
    const dirPath = path.dirname(filePath)

    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true })
    }

    const now = new Date()
    const formattedTime = now.toLocaleString('id-ID', {
        dateStyle: 'full',
        timeStyle: 'medium'
    })

    const data = {
        reason,
        time: formattedTime
    }

    fs.writeFileSync(filePath, JSON.stringify({ reason }, null, 2))
}

function loadOfflineReason(sessionName) {
    const filePath = getReasonFile(sessionName)
    if (fs.existsSync(filePath)) {
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
            return {
                reason: data.reason || "Owner sedang offline.",
                time: data.time || "Waktu tidak tersedia."
            }
        } catch (err) {
            return {
                reason: "Owner sedang offline.",
                time: "Waktu tidak tersedia."
            }
        }
    }
    return {
        reason: "Owner sedang offline.",
        time: "Waktu tidak tersedia."
    }
}

// ===================================== BOT =====================================

async function startBot(sessionPath) {
    const sessionName = path.basename(sessionPath)
    offlineMode.set(sessionName, !getBotStatus(sessionName))
    let defaultAssistant = loadDefaultAssistant(sessionName)

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    })

    if (!replyCooldown.has(sessionName)) replyCooldown.set(sessionName, new Map())

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            console.log("📲 QR tersedia, buka /qr di browser untuk scan")
            latestQR = await QRCode.toDataURL(qr)
            isConnected = false
        }

        if (connection === 'open') {
            console.log(`✅ Bot ${sessionName} terhubung ke WhatsApp!`)
            latestQR = ""
            isConnected = true
            botStatus.set(sessionName, '🟢 Online')
        } else if (connection === 'close') {
            const reason = (lastDisconnect?.error)?.output?.statusCode
            console.log(`❌ Bot ${sessionName} disconnected. Reason:`, reason)
            botStatus.set(sessionName, '🔴 Offline')

            if (reason !== DisconnectReason.loggedOut) startBot(sessionPath)
        }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            if (type !== 'notify') return
            const msg = messages[0]
            if (!msg.message) return

            const sessionCooldown = replyCooldown.get(sessionName)
            const from = msg.key.remoteJid
            const isGroup = from.endsWith('@g.us')
            const sender = msg.key.participant || msg.key.remoteJid
            const senderId = sender.split('@')[0]
            const pesan = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
            const isFromMe = msg.key.fromMe
            const asisten = defaultAssistant

            if (pesan.toLowerCase() === '!ping') {
                await sock.sendMessage(from, { text: `*Pong!*` })
            }

            if (pesan === '!status') {
                const allStatus = Array.from(botStatus.entries()).map(([name, status]) => `• *${name}*: ${status}`).join('\n')
                await sock.sendMessage(from, { text: `📊 *Status semua akun:* \n${allStatus}` })
                return
            }

            if (pesan.startsWith('!off ')) {
                const reason = pesan.slice(5).trim()

                offlineMode.set(sessionName, true)
                setBotStatus(sessionName, false)

                if (reason) saveOfflineReason(sessionName, reason)
                
                await sock.sendMessage(from, { 
                    text: `🤖 Mode offline diaktifkan.${
                        reason ? `\n📝 Alasan: *${reason}*` : ''
                    }\n⏱ Waktu: *${new Date().toLocaleString('id-ID')}*`
                })
                return
            }

            if (pesan === '!on') {
                offlineMode.set(sessionName, false)
                setBotStatus(sessionName, true)
                await sock.sendMessage(from, { text: '🤖 Mode online diaktifkan.' })
            }

            if (pesan.startsWith('!defaultasisten ')) {
                const namaDefault = pesan.slice(16).trim()
                if (namaDefault) {
                    defaultAssistant = namaDefault
                    saveDefaultAssistant(sessionName, defaultAssistant)
                    await sock.sendMessage(from, { text: `✅ Default asisten sekarang: *${defaultAssistant}*` })
                }
                return
            }

            if (pesan.startsWith('!setowner ')) {
                const args = pesan.slice(10).trim().split('|')
                const namaOwner = args[0]?.trim()
                const gender = args[1]?.trim().toLowerCase()

                if (!namaOwner) {
                    await sock.sendMessage(from, { text: `⚠️ Format salah.\nContoh: *!setowner <nama> | <male/female>*` })
                    return
                }

                saveOwnerCall(sessionName, namaOwner, gender)
                await sock.sendMessage(from, { text: `👑 Owner diset ke: *${namaOwner}* ${gender ? `(gender: ${gender})` : ''}` })
                return
            }

            if (!isUserOffline(sessionName)) return
            if (isFromMe) return

            if (isGroup) {
                const contextInfo = msg.message?.extendedTextMessage?.contextInfo || {}
                const mentionJid = contextInfo.mentionedJid || []
                const quotedSender = contextInfo.participant
                const botJid = sock.user.id
                const botNumber = botJid.split('@')[0].split(':')[0]

                const isTagged = mentionJid.some(jid => jid.split('@')[0] === botNumber)
                const isNameMentioned = pesan.includes(botNumber)
                const isReplyToBot = quotedSender && quotedSender.split('@')[0].includes(botNumber)

                if (isTagged || isNameMentioned || isReplyToBot) {
                    const now = Date.now()
                    const key = `${from}:${senderId}`
                    const last = sessionCooldown.get(key) || 0

                    if (now - last >= 300000) {
                        sessionCooldown.set(key, now)
                        const sapa = getSapaan()
                        const ownerName = loadOwnerCall(sessionName)
                        const {reason, time} = loadOfflineReason(sessionName)
                        await sock.sendMessage(from, {
                            text: `${sapa} \n*Halo* @${senderId} \n\n> Saat ini ${ownerName} sedang offline. \n*Reason:* ${reason}. \n*Sejak:* ${time}. \nTinggalkan pesan di bawah ini. \n\nBot:*${asisten}*`,
                            mentions: [sender]
                        })
                    }
                }
            } else {
                const now = Date.now()
                const last = sessionCooldown.get(from) || 0

                if (now - last >= 300000) {
                    sessionCooldown.set(from, now)
                    const sapa = getSapaan()
                    const ownerName = loadOwnerCall(sessionName)
                    const {reason, time} = loadOfflineReason(sessionName)

                    await sock.sendMessage(from, {
                        text: `${sapa}, \n\n> Saat ini ${ownerName} sedang offline. \nReason: ${reason}. \nSejak: ${time} \nTinggalkan pesan dibawah ini. \n\nBot: *${asisten}*`
                    })
                }
            }
        } catch (err) {
            console.error('❌ Gagal proses pesan:', err)
        }
    })
}

async function loadAllSessions() {
    const basePath = 'sessions/'
    const sessionFolders = fs.readdirSync(basePath)
        .filter(name => name.startsWith('auth_info_') && fs.statSync(path.join(basePath, name)).isDirectory())

    for (const folder of sessionFolders) {
        const sessionPath = path.join(basePath, folder)
        startBot(sessionPath)
    }
}

const app = express()
const PORT = 3000

app.get("/", (req, res) => {
    res.send(`
        <h2>WhatsApp Bot Panel</h2>
        <p>Status: ${isConnected ? "🟢 Connected" : "🔴 Waiting for QR"}</p>
        <a href="/qr"><button>Lihat QR Code</button></a>
    `)
})

app.get("/qr", (req, res) => {
    if (!latestQR) {
        return res.send(`<h3>Bot sudah login ✔</h3><br><a href="/">Kembali</a>`)
    }

    res.send(`
        <h2>Scan QR WhatsApp untuk Login</h2>
        <img src="${latestQR}" />
        <br><br>
        <a href="/">Kembali</a>
    `)
})

app.listen(PORT, () => console.log(`🚀 Panel Express berjalan di http://localhost:${PORT}`))

loadAllSessions()
