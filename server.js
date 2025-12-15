// FILE: server.js
// Back-End IMIP CCTV (Login + Dashboard)
// ======================================

// Bersihkan folder streams saat server start

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const multer = require('multer');
const xlsx = require('xlsx');
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ping = require('ping');
const rateLimit = require('express-rate-limit');
require('dotenv').config();
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';


const app = express();
const port = process.env.PORT || 3000;




// --- KONFIGURASI IP RANGE CCTV ---
const IP_START = '10.88.16.2';
const IP_END = '10.88.24.32';
const IP_PREFIX = '/21';
const IP_TOTAL_SPACE = 2078; // Jumlah IP yang diperhitungkan
const OFFLINE_ALERT_MINUTES = 5; // bisa kamu ubah jadi 10, 30, dll
// Multer untuk upload Excel (pakai memory, tidak simpan ke disk)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // maks 10 MB
});

// --- JWT SECRET ---
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('JWT_SECRET belum diset di file .env');
    process.exit(1);
}

// --- KONFIGURASI DATABASE ---
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'imip_cctv_db'
};

// --- KONFIGURASI RTSP UNTUK LIVE HLS ---
const RTSP_USER = process.env.RTSP_USER || 'admin';
const RTSP_PASS = process.env.RTSP_PASS || 'imip1234';
const RTSP_PORT = process.env.RTSP_PORT || 554;
const RTSP_PATH = process.env.RTSP_PATH || '/Streaming/Channels/101';

// Folder untuk file HLS (.m3u8 & .ts)
const STREAMS_DIR = path.join(__dirname, 'streams');
if (!fs.existsSync(STREAMS_DIR)) {
    fs.mkdirSync(STREAMS_DIR, { recursive: true });
}

// Bersihkan folder streams saat server start
fs.rm(STREAMS_DIR, { recursive: true, force: true }, (err) => {
    if (err) {
        console.error('Gagal menghapus folder streams saat start:', err);
    }
    fs.mkdirSync(STREAMS_DIR, { recursive: true });
});

// Simpan proses ffmpeg aktif per kamera
const activeStreams = new Map(); // key: cameraId, value: child_process

function buildRtspUrl(ip) {
    return `rtsp://${encodeURIComponent(RTSP_USER)}:${encodeURIComponent(RTSP_PASS)}@${ip}:${RTSP_PORT}${RTSP_PATH}`;
}

function getStreamFolder(cameraId) {
    return path.join(STREAMS_DIR, `camera_${cameraId}`);
}

function removeStreamFolder(cameraId) {
    const folder = getStreamFolder(cameraId);
    fs.rm(folder, { recursive: true, force: true }, (err) => {
        if (err) {
            console.error(`Gagal menghapus folder stream kamera ${cameraId}:`, err);
        } else {
            console.log(`Folder stream kamera ${cameraId} dihapus.`);
        }
    });
}

// Tunggu sampai file index.m3u8 muncul
function waitForFile(filePath, timeoutMs = 8000) {
    return new Promise((resolve) => {
        const interval = 200;
        let waited = 0;

        const timer = setInterval(() => {
            waited += interval;
            if (fs.existsSync(filePath)) {
                clearInterval(timer);
                resolve(true);
            } else if (waited >= timeoutMs) {
                clearInterval(timer);
                resolve(false);
            }
        }, interval);
    });
}

const pool = mysql.createPool(dbConfig);



// Tes koneksi database sekali di awal
async function testDatabaseConnection() {
    try {
        const conn = await pool.getConnection();
        console.log('✅ Koneksi MySQL berhasil!');
        conn.release();
    } catch (error) {
        console.error('❌ GAGAL Koneksi MySQL. Periksa kredensial & status MySQL.');
        console.error('Error Detail:', error.message);
        process.exit(1);
    }
}
testDatabaseConnection();

// --- MIDDLEWARE PARSER BODY ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- RATE LIMITER UNTUK LOGIN ---
const loginLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,          // 5 menit
    max: 20,                          // maks 20 request / IP per 5 menit
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Terlalu banyak percobaan login dari IP ini. Coba lagi beberapa menit lagi.'
    }
});

// --- MIDDLEWARE VERIFY TOKEN (dipakai hanya di /api/*) ---
const verifyToken = (req, res, next) => {
    let token = null;

    // 1) Coba dari header Authorization: Bearer <token>
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7).trim();
    }

    // 2) Jika tidak ada di header, coba dari query ?token=...
    if (!token && req.query && req.query.token) {
        token = req.query.token.toString().trim();
    }

    if (!token) {
        return res.status(401).json({
            success: false,
            message: 'Akses ditolak. Token tidak ditemukan.'
        });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({
            success: false,
            message: 'Token tidak valid atau sudah kedaluwarsa.'
        });
    }
};

// Hanya izinkan role administrator
const verifyAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'administrator') {
        return res.status(403).json({
            success: false,
            message: 'Hanya administrator yang dapat mengakses endpoint ini.'
        });
    }
    next();
};

// ==== API ADMIN USER ====

app.get('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT user_id, username, role, nama_lengkap FROM users ORDER BY user_id ASC'
        );
        res.json({ success: true, users: rows });
    } catch (err) {
        console.error('Error saat mengambil daftar user:', err);
        res.status(500).json({
            success: false,
            message: 'Gagal memuat daftar user.'
        });
    }
});

app.post('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
    const { username, password, role = 'viewer', nama_lengkap = null } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            success: false,
            message: 'Username dan Password wajib diisi.'
        });
    }

    if (!['administrator', 'viewer'].includes(role)) {
        return res.status(400).json({
            success: false,
            message: 'Role tidak valid.'
        });
    }

    try {
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);

        const [result] = await pool.execute(
            'INSERT INTO users (username, password_hash, role, nama_lengkap) VALUES (?, ?, ?, ?)',
            [username, hash, role, nama_lengkap]
        );

        res.status(201).json({
            success: true,
            message: 'User berhasil ditambahkan.',
            user_id: result.insertId
        });

    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({
                success: false,
                message: 'Username sudah terdaftar.'
            });
        }
        console.error('Error saat menambah user:', err);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server saat menambah user.'
        });
    }
});

// Update data kamera (ADMIN SAJA)
app.put('/api/admin/cameras/:id', verifyToken, verifyAdmin, async (req, res) => {
    const cameraId = req.params.id;

    const {
        cctv_brand = '',
        type,
        name,
        area,
        ip_address = '',
        mac_address = '',
        latitude = '',
        longitude = ''
    } = req.body;

    if (!type || !name || !area) {
        return res.status(400).json({
            success: false,
            message: 'Type, Nama, dan Area wajib diisi.'
        });
    }

    try {
        const [result] = await pool.execute(
            `UPDATE cameras
             SET cctv_brand = ?,
                 type = ?,
                 ip_address = ?,
                 name = ?,
                 latitude = ?,
                 longitude = ?,
                 area = ?,
                 location = ?,
                 mac_address = ?
             WHERE camera_id = ?`,
            [
                cctv_brand,
                type,
                ip_address,
                name,
                latitude,
                longitude,
                area,
                area,          // location = area
                mac_address,
                cameraId
            ]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: 'Kamera tidak ditemukan.'
            });
        }

        res.json({
            success: true,
            message: 'Kamera berhasil diperbarui.'
        });

    } catch (err) {
        console.error('Error saat mengupdate kamera:', err);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server saat mengupdate kamera.'
        });
    }
});

app.delete('/api/admin/users/:id', verifyToken, verifyAdmin, async (req, res) => {
    const targetId = parseInt(req.params.id, 10);

    try {
        // cegah user menghapus dirinya sendiri
        if (targetId === req.user.user_id) {
            return res.status(400).json({
                success: false,
                message: 'Tidak dapat menghapus user yang sedang login.'
            });
        }

        const [result] = await pool.execute(
            'DELETE FROM users WHERE user_id = ?',
            [targetId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: 'User tidak ditemukan.'
            });
        }

        res.json({
            success: true,
            message: 'User berhasil dihapus.'
        });

    } catch (err) {
        console.error('Error saat menghapus user:', err);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server saat menghapus user.'
        });
    }
});
// Tambah kamera baru (ADMIN SAJA)
app.post('/api/admin/cameras', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const {
            cctv_brand = '',
            type,
            name,
            area,
            ip_address = '',
            mac_address = '',
            latitude = '',
            longitude = ''
        } = req.body;

        if (!type || !name || !area) {
            return res.status(400).json({
                success: false,
                message: 'Type, Nama, dan Area wajib diisi.'
            });
        }

        const [result] = await pool.execute(
            `INSERT INTO cameras
             (cctv_brand, type, ip_address, name, latitude, longitude, area, location, mac_address, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline')`,
            [
                cctv_brand,
                type,
                ip_address,
                name,
                latitude,
                longitude,
                area,
                area,     // location = area
                mac_address
            ]
        );

        res.json({
            success: true,
            message: 'Kamera berhasil ditambahkan.',
            camera_id: result.insertId
        });

    } catch (err) {
        console.error('Error saat menambah kamera:', err);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server saat menambah kamera.'
        });
    }
});

// Hapus kamera (ADMIN SAJA)
app.delete('/api/admin/cameras/:id', verifyToken, verifyAdmin, async (req, res) => {
    const cameraId = req.params.id;

    try {
        const [result] = await pool.execute(
            'DELETE FROM cameras WHERE camera_id = ?',
            [cameraId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: 'Kamera tidak ditemukan.'
            });
        }

        res.json({
            success: true,
            message: 'Kamera berhasil dihapus.'
        });

    } catch (err) {
        console.error('Error saat menghapus kamera:', err);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server saat menghapus kamera.'
        });
    }
});
// Export daftar kamera (sesuai filter) ke Excel
app.get('/api/cameras-export', verifyToken, async (req, res) => {
    try {
        const { search = '', status = 'all', area = 'all' } = req.query;

        let sql =
            "SELECT " +
            " cctv_brand AS `CCTV`, " +
            " type AS `Type Device`, " +
            " ip_address AS `IP Address`, " +
            " name AS `OSD/SSID`, " +
            " latitude AS `Latitude`, " +
            " longitude AS `Longitude`, " +
            " area AS `Area`, " +
            " location AS `Location`, " +
            " status AS `Status`, " +
            " mac_address AS `MAC Address` " +
            "FROM cameras WHERE 1=1 ";
        const params = [];

        const s = search.toLowerCase().trim();

        if (status === 'online' || status === 'offline') {
            sql += "AND status = ? ";
            params.push(status);
        }

        if (area && area !== 'all') {
            sql += "AND LOWER(location) = ? ";
            params.push(area.toLowerCase());
        }

        if (s) {
            const like = `%${s}%`;
            sql +=
                "AND (LOWER(type) LIKE ? " +
                "OR LOWER(name) LIKE ? " +
                "OR LOWER(location) LIKE ? " +
                "OR LOWER(ip_address) LIKE ? " +
                "OR LOWER(mac_address) LIKE ?) ";
            params.push(like, like, like, like, like);
        }

        const [rows] = await pool.execute(sql, params);

        const wb = xlsx.utils.book_new();
        const ws = xlsx.utils.json_to_sheet(rows);
        xlsx.utils.book_append_sheet(wb, ws, 'Cameras');

        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Disposition', 'attachment; filename="cameras_export.xlsx"');
        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.send(buffer);

    } catch (err) {
        console.error('Error saat export kamera:', err);
        res.status(500).json({
            success: false,
            message: 'Gagal melakukan export data kamera.'
        });
    }
});

// =========================
//  AUTH: REGISTER & LOGIN
// =========================

// Endpoint Pendaftaran (untuk setup awal)
app.post('/api/register', async (req, res) => {
    const { username, password, role = 'viewer', nama_lengkap = null } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: 'Username dan password wajib diisi.' });
    }

    try {
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);

        const [result] = await pool.execute(
            'INSERT INTO users (username, password_hash, role, nama_lengkap) VALUES (?, ?, ?, ?)',
            [username, password_hash, role, nama_lengkap]
        );

        res.status(201).json({
            message: 'User berhasil didaftarkan.',
            userId: result.insertId
        });

    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'Username sudah terdaftar.' });
        }
        console.error('Error saat registrasi:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// Endpoint Login
app.post('/api/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({
            success: false,
            message: 'Harap isi Username dan Password.'
        });
    }

    try {
        // Ambil user dari database
        const [rows] = await pool.execute(
            'SELECT user_id, username, password_hash, role, nama_lengkap FROM users WHERE username = ?',
            [username]
        );

        if (rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Username atau Password salah.'
            });
        }

        const user = rows[0];

        // Cocokkan password
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({
                success: false,
                message: 'Username atau Password salah.'
            });
        }

        // Buat JWT
        const payload = {
            user_id: user.user_id,
            username: user.username,
            role: user.role,
            nama_lengkap: user.nama_lengkap
        };

        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });

        res.json({
            success: true,
            message: 'Login berhasil!',
            token
        });

    } catch (error) {
        console.error('Database Error saat login:', error);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan server.'
        });
    }
});

// =========================
//  STATIC FILES & DASHBOARD
// =========================


// Serve file statis (index.html, style.css, Script/script.js, dashboard.css, dll)
app.use(express.static(__dirname));
// Serve file HLS (.m3u8, .ts) untuk live view
app.use('/streams', express.static(STREAMS_DIR));
// Route untuk Dashboard (HTML saja, data tetap lewat /api yang pakai JWT)
app.get('/dashboard', (req, res) => {
    res.sendFile(__dirname + '/dashboard.html');
});


// =========================
//  BACKGROUND JOB CEK STATUS KAMERA
// =========================

const BATCH_SIZE = 100;   // berapa kamera yang di-ping sekaligus

async function checkCameraStatusOnce() {
    console.log('Mulai cek status kamera...');

    try {
        const [cameras] = await pool.execute(
            "SELECT camera_id, ip_address FROM cameras " +
            "WHERE ip_address IS NOT NULL AND ip_address <> ''"
        );

        console.log(`Jumlah kamera yang akan dicek: ${cameras.length}`);

        // Proses dalam batch agar tidak terlalu berat
        for (let i = 0; i < cameras.length; i += BATCH_SIZE) {
            const batch = cameras.slice(i, i + BATCH_SIZE);

            console.log(`Memproses batch ${i + 1} sampai ${i + batch.length}`);

            await Promise.all(
                batch.map(async (cam) => {
                    try {
                        const res = await ping.promise.probe(cam.ip_address, {
                            timeout: 2,
                            extra: ['-n', '1']   // cocok untuk Windows
                        });

                        const isOnline = res.alive;
                        const newStatus = isOnline ? 'online' : 'offline';

                        await pool.execute(
                            "UPDATE cameras " +
                            "SET status = ?, last_check = NOW(), " +
                            "    last_seen = IF(?, NOW(), last_seen) " +
                            "WHERE camera_id = ?",
                            [newStatus, isOnline ? 1 : 0, cam.camera_id]
                        );
                    } catch (err) {
                        await pool.execute(
                            "UPDATE cameras " +
                            "SET status = 'offline', last_check = NOW() " +
                            "WHERE camera_id = ?",
                            [cam.camera_id]
                        );
                    }
                })
            );
        }
        // Setelah update semua kamera, simpan statistik harian (total & offline)
        const [statRows] = await pool.execute(
            "SELECT " +
            "COUNT(*) AS total, " +
            "SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) AS offline " +
            "FROM cameras"
        );
        const total = Number(statRows[0].total) || 0;
        const offline = Number(statRows[0].offline) || 0;

        await pool.execute(
            "INSERT INTO camera_daily_stats (stat_date, total_cameras, offline_cameras) " +
            "VALUES (CURDATE(), ?, ?) " +
            "ON DUPLICATE KEY UPDATE " +
            " total_cameras = VALUES(total_cameras), " +
            " offline_cameras = VALUES(offline_cameras)",
            [total, offline]
        );

        console.log(`✅ Cek status kamera selesai, jumlah: ${cameras.length}`);


    } catch (error) {
        console.error('❌ Error saat cek status kamera:', error.message);
    }
}

// Jalankan cek status setiap 1 menit
if (process.env.ENABLE_PING === 'true') {
    // Jalankan cek status setiap 1 menit
    setInterval(checkCameraStatusOnce, 1 * 60 * 1000);

    // (Opsional) jalankan sekali saat server baru start
    checkCameraStatusOnce();
}

// =========================
//  API UNTUK DASHBOARD
// =========================

// Daftar semua kamera
app.get('/api/cameras-list', verifyToken, async (req, res) => {
    try {
        const [cameras] = await pool.execute(
            'SELECT ' +
            '  camera_id, ' +
            '  cctv_brand, ' +
            '  type, ' +
            '  name, ' +
            '  location, ' +
            '  area, ' +
            '  ip_address, ' +
            '  status, ' +
            '  mac_address, ' +
            '  latitude, ' +
            '  longitude, ' +
            '  last_check, ' +
            '  last_seen ' +
            'FROM cameras ' +
            'ORDER BY camera_id ASC'
        );

        res.json({
            success: true,
            cameras: cameras
        });

    } catch (error) {
        console.error('Database Error saat mengambil daftar kamera:', error);
        res.status(500).json({ success: false, message: 'Gagal memuat daftar kamera.' });
    }
});

// Notifikasi kamera yang offline lebih dari OFFLINE_ALERT_MINUTES
app.get('/api/offline-alerts', verifyToken, async (req, res) => {
    try {
        // Durasi offline dihitung dari:
        // - last_seen  : kalau kamera pernah online
        // - created_at : kalau belum pernah online (baru diimport)
        const [rows] = await pool.execute(
            `SELECT 
                camera_id,
                name,
                location,
                ip_address,
                TIMESTAMPDIFF(
                    MINUTE, 
                    CASE
                        WHEN last_seen IS NOT NULL THEN last_seen
                        ELSE created_at
                    END,
                    NOW()
                ) AS offline_minutes
             FROM cameras
             WHERE status = 'offline'
               AND (
                    last_seen IS NOT NULL
                    OR created_at IS NOT NULL
               )
               AND TIMESTAMPDIFF(
                     MINUTE, 
                     CASE
                         WHEN last_seen IS NOT NULL THEN last_seen
                         ELSE created_at
                     END,
                     NOW()
                   ) >= ?
             ORDER BY offline_minutes DESC`,
            [OFFLINE_ALERT_MINUTES]
        );

        res.json({
            success: true,
            thresholdMinutes: OFFLINE_ALERT_MINUTES,
            count: rows.length,
            cameras: rows
        });

    } catch (error) {
        console.error('Database Error saat mengambil offline alerts:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal memuat notifikasi offline.'
        });
    }
});

// Trend kamera offline per hari (default 7 hari terakhir)
app.get('/api/offline-trend', verifyToken, async (req, res) => {
    try {
        const days = parseInt(req.query.days, 10) || 7;
        const range = Math.max(days, 1);

        const [rows] = await pool.execute(
            "SELECT stat_date, offline_cameras " +
            "FROM camera_daily_stats " +
            "WHERE stat_date >= CURDATE() - INTERVAL ? DAY " +
            "ORDER BY stat_date ASC",
            [range - 1]
        );

        res.json({
            success: true,
            points: rows
        });

    } catch (err) {
        console.error('Error saat mengambil offline trend:', err);
        res.status(500).json({
            success: false,
            message: 'Gagal memuat trend offline.'
        });
    }
});

// Metrik utama dashboard
app.get('/api/metrics', verifyToken, async (req, res) => {
    try {
        // Total & online cameras
        const [cameraCounts] = await pool.execute(
            "SELECT COUNT(*) AS total_cameras, " +
            "SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online_cameras " +
            "FROM cameras"
        );

        const total_cameras = Number(cameraCounts[0].total_cameras) || 0;
        const online_cameras = Number(cameraCounts[0].online_cameras) || 0;

        // IP terpakai
        const [ipCounts] = await pool.execute(
            "SELECT COUNT(ip_address) AS used_ip " +
            "FROM cameras " +
            "WHERE ip_address IS NOT NULL AND ip_address <> ''"
        );
        const used_ip = Number(ipCounts[0].used_ip) || 0;

        const remaining_ip = IP_TOTAL_SPACE - used_ip;
        const ip_usage_percentage =
            IP_TOTAL_SPACE > 0 ? (used_ip / IP_TOTAL_SPACE) * 100 : 0;

        const network_status = online_cameras > 0 ? 'Online' : 'Offline';

        // REKAP PER LOKASI (pakai kolom location)
        const [areaRows] = await pool.execute(
            "SELECT " +
            "  COALESCE(NULLIF(location, ''), area, 'Tidak diketahui') AS area, " +
            "  COUNT(*) AS total, " +
            "  SUM(CASE WHEN status = 'online'  THEN 1 ELSE 0 END) AS online, " +
            "  SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) AS offline " +
            "FROM cameras " +
            "GROUP BY area " +
            "ORDER BY area ASC"
        );

        const areaStats = areaRows.map(r => ({
            area: r.area,
            total: Number(r.total) || 0,
            online: Number(r.online) || 0,
            offline: Number(r.offline) || 0,
            error: Number(r.error) || 0
        }));

        res.json({
            success: true,
            metrics: {
                totalCameras: total_cameras,
                onlineCameras: online_cameras,
                ipUsage: {
                    total: IP_TOTAL_SPACE,
                    used: used_ip,
                    remaining: remaining_ip,
                    percentage: Math.round(ip_usage_percentage),
                    range: `${IP_START} - ${IP_END}`,
                    prefix: IP_PREFIX
                },
                networkStatus: network_status,
                areaStats: areaStats          // <- tambahan
            }
        });

    } catch (error) {
        console.error('Database Error saat mengambil metrik:', error);
        res.status(500).json({
            success: false,
            message: 'Gagal memuat data metrik.'
        });
    }
});

// Import data kamera dari file Excel (.xlsx)
// PERHATIAN: ini akan MENGOSONGKAN (TRUNCATE) tabel cameras, lalu mengisi lagi dari file
app.post(
    '/api/admin/import-cameras',
    verifyToken,
    verifyAdmin,
    upload.single('file'),          // field name "file"
    async (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'File tidak ditemukan. Pilih file Excel terlebih dahulu.'
            });
        }

        try {
            // Baca workbook dari buffer
            const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });

            // Pakai sheet pertama
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];

            // Baca sebagai array-of-arrays (baris), supaya tidak bergantung nama header
            const data = xlsx.utils.sheet_to_json(sheet, {
                header: 1,  // baris jadi array index: [A,B,C,D,E,F,G,H]
                defval: ''  // kalau kosong, jadi string kosong, bukan undefined
            });

            if (!data || data.length < 2) {
                return res.status(400).json({
                    success: false,
                    message: 'File Excel tidak berisi data (minimal 1 baris header + 1 baris data).'
                });
            }

            // Buang baris pertama (header)
            const rows = data.slice(1);
            const values = [];

            for (const row of rows) {
                // Pastikan panjang row minimal 8 kolom
                const [
                    cctv_brand_raw,
                    type_raw,
                    ip_raw,
                    name_raw,
                    lat_raw,
                    lon_raw,
                    area_raw,
                    mac_raw
                ] = row;

                const cctv_brand = (cctv_brand_raw || '').toString().trim();
                const type = (type_raw || '').toString().trim();
                const ip_address = (ip_raw || '').toString().trim();
                const name = (name_raw || '').toString().trim();
                const latitude = (lat_raw || '').toString().trim().replace('°', '');
                const longitude = (lon_raw || '').toString().trim().replace('°', '');
                const area = (area_raw || '').toString().trim();
                const mac = (mac_raw || '').toString().trim();

                // Skip baris yang benar-benar kosong (tidak ada type, ip, name, area)
                if (!type && !ip_address && !name && !area) continue;

                values.push([
                    cctv_brand,
                    type,
                    ip_address,
                    name,
                    latitude,
                    longitude,
                    area,
                    area,  // location = area
                    mac
                ]);
            }

            if (!values.length) {
                return res.status(400).json({
                    success: false,
                    message: 'Tidak ada baris valid ditemukan di file Excel (cek urutan kolom).'
                });
            }

            // TRUNCATE + INSERT (tanpa transaksi rumit, auto-commit)
            await pool.query('TRUNCATE TABLE cameras');

            const sql =
                'INSERT INTO cameras ' +
                '(cctv_brand, type, ip_address, name, latitude, longitude, area, location, mac_address) ' +
                'VALUES ?';

            await pool.query(sql, [values]);

            // Setelah import, set semua offline dulu (nanti job ping akan update)
            await pool.execute(
                "UPDATE cameras SET status = 'offline', last_check = NULL, last_seen = NULL"
            );

            // (Opsional) ping sekali langsung setelah import
            checkCameraStatusOnce().catch(err => {
                console.error('Error saat cek status setelah import:', err);
            });

            res.json({
                success: true,
                message: 'Import data kamera berhasil.',
                inserted: values.length
            });

        } catch (err) {
            console.error('Error saat memproses file Excel:', err);
            res.status(400).json({
                success: false,
                message: 'File Excel tidak valid atau format kolom tidak sesuai (A–H).'
            });
        }
    }
);

// Data user (untuk welcome message & RBAC)
app.get('/api/user-data', verifyToken, (req, res) => {
    res.json({
        success: true,
        user: req.user
    });
});
// Mulai / gunakan stream HLS untuk kamera tertentu
app.post('/api/live/start/:id', verifyToken, async (req, res) => {
    const cameraId = parseInt(req.params.id, 10);
    if (!cameraId) {
        return res.status(400).json({ success: false, message: 'ID kamera tidak valid.' });
    }

    try {
        // Ambil IP kamera dari DB
        const [rows] = await pool.execute(
            'SELECT ip_address FROM cameras WHERE camera_id = ?',
            [cameraId]
        );

        if (!rows.length || !rows[0].ip_address) {
            return res.status(404).json({
                success: false,
                message: 'IP kamera tidak ditemukan di database.'
            });
        }

        const ip = rows[0].ip_address;
        const rtspUrl = buildRtspUrl(ip);

        const folder = getStreamFolder(cameraId);
        if (!fs.existsSync(folder)) {
            fs.mkdirSync(folder, { recursive: true });
        }

        const playlistPath = path.join(folder, 'index.m3u8');
        const hlsUrl = `/streams/camera_${cameraId}/index.m3u8`;

        // Kalau sudah ada ffmpeg jalan untuk kamera ini, tidak usah spawn lagi
        if (!activeStreams.has(cameraId)) {
            console.log(`Memulai ffmpeg untuk kamera ${cameraId} (${ip})`);

            const ff = spawn(FFMPEG_PATH, [
                '-rtsp_transport', 'tcp',
                '-i', rtspUrl,
                '-fflags', '+genpts',
                '-c:v', 'copy',
                '-an',
                '-preset', 'veryfast',
                '-f', 'hls',
                '-hls_time', '2',
                '-hls_list_size', '5',
                '-hls_flags', 'delete_segments+append_list',
                playlistPath
            ]);

            ff.stderr.on('data', (data) => {
                console.log(`[ffmpeg ${cameraId}] ${data}`);
            });

            ff.on('error', (err) => {
                console.error(`Gagal menjalankan ffmpeg untuk kamera ${cameraId}:`, err);
                activeStreams.delete(cameraId);
                removeStreamFolder(cameraId);
            });

            ff.on('close', (code) => {
                console.log(`ffmpeg kamera ${cameraId} berhenti dengan kode ${code}`);
                activeStreams.delete(cameraId);
            });

            activeStreams.set(cameraId, ff);
        } else {
            console.log(`Stream kamera ${cameraId} sudah aktif, pakai yang lama.`);
        }

        const ready = await waitForFile(playlistPath, 8000);
        if (!ready) {
            console.warn(`Stream kamera ${cameraId} gagal dibuat, hapus folder & proses ffmpeg.`);

            // hentikan ffmpeg kalau ada
            const proc = activeStreams.get(cameraId);
            if (proc) {
                proc.kill('SIGKILL'); // atau 'SIGTERM'
                activeStreams.delete(cameraId);
            }

            // hapus folder /streams/camera_xxx
            removeStreamFolder(cameraId);

            return res.status(500).json({
                success: false,
                message: 'Stream tidak bisa dibuat (cek RTSP / koneksi kamera).'
            });
        }

        res.json({
            success: true,
            message: 'Stream dimulai / sudah aktif.',
            hlsUrl
        });

    } catch (err) {
        console.error('Error /api/live/start:', err);
        res.status(500).json({
            success: false,
            message: 'Gagal memulai stream kamera.'
        });
    }
});
// =========================
//  JALANKAN SERVER
// =========================
app.listen(port, () => {
    console.log(`Server IMIP CCTV berjalan di http://localhost:${port}`);
    console.log('Pastikan MySQL Server (XAMPP/WAMP) sudah berjalan.');
});