// Script/script.js

// =============================
//  VARIABEL GLOBAL DASHBOARD
// =============================

let previousCameraStatus = {};    // untuk highlight perubahan status
let allCameras = [];             // semua kamera (untuk filter)
let changedCameraIds = new Set();// id kamera yang statusnya berubah

// Live view pagination state
let liveCurrentPage = 1;
let liveFilteredCameras = [];
const LIVE_PAGE_SIZE = 25;
let livePaginationInitialized = false;
// Sorting live view
let liveSortField = 'name';   // 'name' atau 'ip'
let liveSortDir = 'asc';      // 'asc' atau 'desc'

const REFRESH_INTERVAL_MS = 60_000;
let autoRefreshIntervalId = null;
let filtersInitialized = false;
let selectedCameraId = null;     // kamera yang sedang ditampilkan di panel detail
let selectedCameraData = null;   // data lengkap kamera terpilih (untuk edit)
// Chart.js instances
let areaChart = null;
let offlineTrendChart = null;
let statusPieChart = null;        // kalau kamu pakai sebelumnya
let totalCamerasDonut = null;     // <-- donut mini kartu total kamera


// ====== SYSTEM MODAL (LOGIN / LOGOUT) ======
let sysModalOverlay = null;
let sysModalIconEl = null;
let sysModalTitleEl = null;
let sysModalMsgEl = null;

function ensureSystemModal() {
    if (sysModalOverlay) return;

    sysModalOverlay = document.createElement('div');
    sysModalOverlay.className = 'sys-modal-overlay';
    sysModalOverlay.innerHTML = `
        <div class="sys-modal-card">
            <div class="sys-modal-icon loading">
                <div class="sys-modal-spinner"></div>
            </div>
            <div class="sys-modal-text">
                <div class="sys-modal-title" id="sysModalTitle"></div>
                <div class="sys-modal-message" id="sysModalMessage"></div>
            </div>
        </div>
    `;
    document.body.appendChild(sysModalOverlay);

    sysModalIconEl = sysModalOverlay.querySelector('.sys-modal-icon');
    sysModalTitleEl = document.getElementById('sysModalTitle');
    sysModalMsgEl = document.getElementById('sysModalMessage');
}

function showSystemModal(title, message, state = 'loading') {
    ensureSystemModal();
    sysModalOverlay.style.display = 'flex';
    updateSystemModal(title, message, state);
}

function updateSystemModal(title, message, state) {
    if (!sysModalOverlay) return;

    if (typeof title === 'string') sysModalTitleEl.textContent = title;
    if (typeof message === 'string') sysModalMsgEl.textContent = message;

    sysModalIconEl.className = 'sys-modal-icon ' + state;

    if (state === 'loading') {
        sysModalIconEl.innerHTML = '<div class="sys-modal-spinner"></div>';
    } else if (state === 'success') {
        sysModalIconEl.innerHTML = '<span class="sys-modal-check">✓</span>';
    } else if (state === 'error') {
        sysModalIconEl.innerHTML = '<span class="sys-modal-error-icon">!</span>';
    } else {
        sysModalIconEl.innerHTML = '';
    }
}

function hideSystemModal() {
    if (!sysModalOverlay) return;
    sysModalOverlay.style.display = 'none';
}

// Leaflet map (Dashboard)
let cameraMap = null;
let cameraMapMarkersLayer = null;

// =============================
//  KONFIGURASI RTSP (LIVE VIEW)
// =============================
// TODO: sesuaikan dengan setting CCTV kamu
const RTSP_USERNAME = 'admin';      // ganti
const RTSP_PASSWORD = 'imip1234';      // ganti
const RTSP_PORT = 554;             // biasanya 554
const RTSP_PATH = '/Streaming/channels/101'; // ganti sesuai vendor


// =============================
//  METRICS & REKAP LOKASI
// =============================

function renderAreaSummaryTable(areaStats) {
    const tbody = document.getElementById('areaSummaryBody');
    if (!tbody) return;

    if (!areaStats || areaStats.length === 0) {
        tbody.innerHTML =
            '<tr><td colspan="4" class="text-center">Tidak ada data rekap lokasi.</td></tr>';
        return;
    }

    tbody.innerHTML = '';

    areaStats.forEach(item => {
        const row = tbody.insertRow();
        row.innerHTML = `
        <td>${item.area}</td>
        <td class="area-total-cell">${item.total}</td>
        <td class="area-online-cell">${item.online}</td>
        <td class="area-offline-cell">${item.offline}</td>
    `;

        // <-- tambahan: klik baris untuk buka modal detail
        row.addEventListener('click', () => {
            const token = localStorage.getItem('authToken');
            showAreaDetails(item.area, token);
        });
    });
}

function renderTopAreas(areaStats) {
    const container = document.getElementById('topAreas');
    if (!container) return;

    if (!Array.isArray(areaStats) || !areaStats.length) {
        container.innerHTML = '<span>Tidak ada data area.</span>';
        return;
    }

    // Urutkan berdasarkan total kamera terbanyak
    const sorted = [...areaStats].sort((a, b) => (b.total || 0) - (a.total || 0));

    // Ambil 3 teratas (atau kurang jika data sedikit)
    const top2 = sorted.slice(0, 2);

    container.innerHTML = '';
    top2.forEach(item => {
        const pill = document.createElement('div');
        pill.className = 'top-area-pill';
        pill.innerHTML = `
            <span class="area-name">${item.area}</span>
            <span class="area-count">${item.total} cam</span>
            <span class="area-online">ON: ${item.online}</span>
            <span class="area-offline">OFF: ${item.offline}</span>
        `;
        container.appendChild(pill);
    });
}

// =============================
//  FUNGSI MODAL DETAIL AREA
// =============================
function showAreaDetails(areaName, token) {
    const modal = document.createElement("div");
    modal.className = "notifications-modal";
    modal.style.zIndex = 999;

    modal.innerHTML = `
        <div class="modal-header">
            <h2>Detail Kamera: ${areaName}</h2>
            <button class="modal-close-btn" id="closeAreaDetail"><i class='bx bx-x'></i></button>
        </div>
        <p class="modal-subtitle">Memuat data kamera di area ini...</p>
        <div class="modal-table-container">
            <table class="notifications-table">
                <thead>
                    <tr>
                        <th>Nama Kamera/Device</th>
                        <th>IP</th>
                        <th>Status</th>
                        <th>Terakhir Check</th>
                    </tr>
                </thead>
                <tbody id="areaDetailBody">
                    <tr><td colspan="4" class="text-center">Loading...</td></tr>
                </tbody>
            </table>
        </div>
    `;

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    document.body.appendChild(backdrop);
    document.body.appendChild(modal);

    const close = () => {
        backdrop.remove();
        modal.remove();
    };
    document.getElementById("closeAreaDetail").addEventListener("click", close);
    backdrop.addEventListener("click", close);

    fetch("/api/cameras-list", {
        headers: { Authorization: `Bearer ${token}` },
    })
        .then((r) => r.json())
        .then((data) => {
            const tbody = document.getElementById("areaDetailBody");
            if (!data.success) {
                tbody.innerHTML = `<tr><td colspan="4" class="text-center">Gagal memuat data.</td></tr>`;
                return;
            }

            const areaSafe = (areaName || "").replace(/\s+/g, "").toLowerCase();
            const filtered = data.cameras.filter((c) => {
                const loc = (c.location || "").replace(/\s+/g, "").toLowerCase();
                const area = (c.area || "").replace(/\s+/g, "").toLowerCase();
                return loc.includes(areaSafe) || area.includes(areaSafe);
            });
            if (!filtered.length) {
                tbody.innerHTML = `<tr><td colspan="4" class="text-center">Tidak ada kamera di area ini.</td></tr>`;
                return;
            }

            tbody.innerHTML = "";
            filtered.forEach((cam) => {
                const row = tbody.insertRow();
                row.innerHTML = `
                    <td>${cam.name}</td>
                    <td>${cam.ip_address || "-"}</td>
                    <td style="color:${cam.status === "online" ? "#4ade80" : "#f87171"
                    }">${cam.status}</td>
                    <td>${cam.last_check
                        ? new Date(cam.last_check).toLocaleString("id-ID")
                        : "-"
                    }</td>`;
            });
        })
        .catch((err) => console.error("Error load area detail:", err));
}

async function fetchMetrics(token) {
    try {
        const response = await fetch('/api/metrics', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
            if (response.status === 401) {
                localStorage.removeItem('authToken');
                alert('Sesi Anda berakhir. Silakan login kembali.');
                window.location.href = '/index.html';
            } else {
                console.warn('Gagal memuat metrik:', result.message || response.statusText);
            }
            return;
        }
        ///===METRICS=== 
        const metrics = result.metrics;
        const total = metrics.totalCameras || 0;
        const online = metrics.onlineCameras || 0;
        const offline = Math.max(total - online, 0);

        // Total kamera (online / total) - teks
        const totalCamEl = document.getElementById('totalCamerasValue');
        if (totalCamEl) totalCamEl.textContent = `${online} / ${total}`;

        // Update donut mini di kartu
        updateTotalCamerasDonut(total, online);

        // Status jaringan (card)
        const networkEl = document.querySelector('#networkStatus .metric-value');
        if (networkEl) {
            networkEl.textContent = metrics.networkStatus;
            networkEl.className = 'metric-value';
            networkEl.classList.add(metrics.networkStatus.toLowerCase());
        }

        // Status jaringan (pill header)
        const headerStatusEl = document.getElementById('headerNetworkStatus');
        if (headerStatusEl) {
            headerStatusEl.textContent = metrics.networkStatus;
            headerStatusEl.style.color = metrics.networkStatus === 'Online'
                ? '#4ade80'
                : '#f97373';
        }

        // Kartu Kamera Offline
        const offlineValueEl = document.querySelector('#offlineCameras .metric-value');
        const offlinePercentEl = document.getElementById('offlinePercent');
        if (offlineValueEl) offlineValueEl.textContent = offline;
        if (offlinePercentEl) {
            const percent = total > 0 ? Math.round((offline / total) * 100) : 0;
            offlinePercentEl.textContent = `${percent}% dari total`;
        }

        // IP Usage
        const ipUsage = metrics.ipUsage;
        const ipRangeEl = document.getElementById('ipRangeInfo');
        const ipValueEl = document.getElementById('ipUsageValue');
        const ipRemainingEl = document.getElementById('ipRemainingText');
        const fillEl = document.querySelector('#ipUsage .progress-bar-fill');
        const percent = ipUsage.percentage;

        if (ipRangeEl && ipUsage.range) ipRangeEl.textContent = `Range: ${ipUsage.range}`;
        if (ipValueEl) ipValueEl.textContent = `${ipUsage.used} / ${ipUsage.total}`;
        if (ipRemainingEl) {
            ipRemainingEl.textContent = `Sisa: ${ipUsage.remaining} IP (Prefix: ${ipUsage.prefix})`;
        }
        if (fillEl) {
            fillEl.style.width = `${percent}%`;
            if (percent > 90) fillEl.classList.add('critical');
            else fillEl.classList.remove('critical');
        }

        // Rekap per lokasi
        if (Array.isArray(metrics.areaStats)) {
            renderAreaSummaryTable(metrics.areaStats);
            updateAreaChart(metrics.areaStats);
            renderTopAreas(metrics.areaStats);   // <-- tambah ini
        }

    } catch (error) {
        console.error('Error fetching metrics:', error);
    }
}

//  COMBINATION CHART: BAR (TOTAL) + LINE (ONLINE %)
function updateAreaChart(areaStats, tokenFromCaller) {
    const canvas = document.getElementById("areaChart");
    if (!canvas || !Array.isArray(areaStats) || !areaStats.length) return;

    const labels = areaStats.map(a => a.area);
    const totals = areaStats.map(a => a.total || 0);
    const onlinePercent = areaStats.map(a =>
        a.total > 0 ? Math.round((a.online / a.total) * 100) : 0
    );

    // gunakan token dari parameter atau dari localStorage
    const token = tokenFromCaller || localStorage.getItem('authToken') || '';

    // hapus chart lama bila ada
    if (areaChart) areaChart.destroy();

    const ctx = canvas.getContext("2d");
    areaChart = new Chart(ctx, {
        type: "bar",                 // <- WAJIB: type di root config
        data: {
            labels,
            datasets: [
                {
                    type: "bar",
                    label: "Total Kamera",
                    data: totals,
                    backgroundColor: "rgba(99,102,241,0.8)",
                    borderColor: "rgba(129,140,248,1)",
                    borderWidth: 1.5,
                    borderRadius: 3,
                    yAxisID: "y",
                    categoryPercentage: 2, // isi 80–100% lebar kategori
                    barPercentage: 1.2,      // bar di dalam kategori juga lebar
                    maxBarThickness: 20      // batasi ketebalan maksimum
                },
                {
                    type: "line",
                    label: "Persentase Online",
                    data: onlinePercent,
                    borderColor: "#4ade80",
                    borderWidth: 2,
                    tension: 0.35,
                    pointRadius: 2,
                    yAxisID: "y2"
                }
            ]
        },
        options: {
            maintainAspectRatio: false,
            responsive: true,
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: { display: true, position: "top", labels: { color: "#cbd5e1" } },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            const ds = ctx.dataset;
                            return ds.type === "bar"
                                ? ` Total: ${ctx.raw}`
                                : ` Online: ${ctx.raw}%`;
                        }
                    }
                },
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        display: false   // sembunyikan label lokasi di sumbu X
                    }
                },
                y: {
                    beginAtZero: true,
                    position: "left",
                    ticks: { color: "#9ca3af", precision: 0 },
                    grid: { color: "rgba(55,65,81,0.4)" },
                    title: {
                        display: true,
                        text: "Total Kamera",
                        color: "#94a3b8"
                    }
                },
                y2: {
                    beginAtZero: true,
                    position: "right",
                    ticks: {
                        color: "#4ade80",
                        callback: v => v + " %"
                    },
                    grid: { drawOnChartArea: false },
                    title: {
                        display: true,
                        text: "Online (%)",
                        color: "#4ade80"
                    }
                }
            }
        }
    });

    // klik batang / titik → detail area
    canvas.onclick = evt => {
        const pts = areaChart.getElementsAtEventForMode(
            evt,
            "index",
            { intersect: false },
            true
        );
        if (!pts.length) return;

        const idx = pts[0].index;
        showAreaDetails(labels[idx], token);
    };
}

// ====== GRAFIK: TREND OFFLINE PER HARI ======
function updateOfflineTrendChart(points) {
    const canvas = document.getElementById('offlineTrendChart');
    if (!canvas || !Array.isArray(points)) return;

    const labels = points.map(p => {
        const d = new Date(p.stat_date);
        if (Number.isNaN(d.getTime())) return p.stat_date;
        return d.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit' });
    });

    const values = points.map(p => p.offline_cameras || 0);

    if (offlineTrendChart) {
        offlineTrendChart.data.labels = labels;
        offlineTrendChart.data.datasets[0].data = values;
        offlineTrendChart.update();
        return;
    }

    offlineTrendChart = new Chart(canvas, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Kamera Offline',
                data: values,
                borderColor: 'rgba(255, 255, 255, 1)',
                backgroundColor: 'rgba(60, 59, 59, 0.08)',
                fill: true,
                tension: 0.25,
                pointRadius: 3,
                pointBackgroundColor: 'rgba(255, 1, 1, 1)'
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => ` ${ctx.parsed.y} kamera offline`
                    }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#ffffffff' },
                    grid: { display: false }
                },
                y: {
                    ticks: { color: '#9ca3af', precision: 0 },
                    grid: { color: 'rgba(255, 255, 255, 1)' }
                }
            }
        }
    });
}


//---MAP MINI---//
function updateCameraMapFromAllCameras() {
    // Hanya jalan kalau ada elemen peta & Leaflet & map sudah dibuat
    const mapContainer = document.getElementById('cameraMap');
    if (!mapContainer || !cameraMap || !cameraMapMarkersLayer) return;
    if (typeof L === 'undefined') return;

    cameraMapMarkersLayer.clearLayers();

    const cams = allCameras || [];
    const bounds = [];

    cams.forEach(cam => {
        const lat = parseFloat(cam.latitude);
        const lon = parseFloat(cam.longitude);
        if (Number.isNaN(lat) || Number.isNaN(lon)) return;

        const status = (cam.status || 'offline').toLowerCase();
        const isOnline = status === 'online';
        const color = isOnline ? '#22c55e' : '#f97373';

        const marker = L.circleMarker([lat, lon], {
            radius: 5,
            color,
            fillColor: color,
            fillOpacity: 0.9,
            weight: 1
        });

        const name = cam.name || 'Tanpa nama';
        const loc = cam.location || cam.area || '-';
        const ip = cam.ip_address || '-';
        const statusLabel = isOnline ? 'ONLINE' : 'OFFLINE';

        marker.bindPopup(
            `<strong>${name}</strong><br>` +
            `${loc}<br>` +
            `<span style="color:${color};font-weight:600">${statusLabel}</span><br>` +
            `<span style="font-size:0.8rem;color:#cbd5f5">IP: ${ip}</span>`
        );

        marker.addTo(cameraMapMarkersLayer);
        bounds.push([lat, lon]);
    });

    if (bounds.length) {
        const latLngBounds = L.latLngBounds(bounds);
        cameraMap.fitBounds(latLngBounds, { padding: [20, 20] });
    } else {
        // fallback pusat area (silakan sesuaikan koordinat IMIP)
        cameraMap.setView([-2.82, 122.15], 11);
    }
}

function initCameraMap() {
    const mapContainer = document.getElementById('cameraMap');
    if (!mapContainer) return;              // bukan di dashboard
    if (typeof L === 'undefined') {
        console.warn('Leaflet belum dimuat, peta tidak bisa ditampilkan.');
        return;
    }

    if (!cameraMap) {
        cameraMap = L.map('cameraMap', {
            zoomControl: true
        });

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; OpenStreetMap contributors'
        }).addTo(cameraMap);

        cameraMapMarkersLayer = L.layerGroup().addTo(cameraMap);
    }

    updateCameraMapFromAllCameras();
}

function updateTotalCamerasDonut(total, online) {
    const canvas = document.getElementById('totalCamerasDonut');
    const percentTextEl = document.getElementById('totalCamerasPercent');
    if (!canvas) return;

    const offline = Math.max(total - online, 0);
    const percent = total > 0 ? Math.round((online / total) * 100) : 0;

    if (percentTextEl) {
        percentTextEl.textContent = percent + '%';
    }

    const ctx = canvas.getContext('2d');
    const data = {
        labels: ['Online', 'Offline'],
        datasets: [{
            data: [online, offline],
            backgroundColor: ['#22c55e', 'rgba(148,163,184,0.25)'],
            borderColor: ['#bbf7d0', 'rgba(148,163,184,0.4)'],
            borderWidth: 1.2
        }]
    };

    if (totalCamerasDonut) {
        totalCamerasDonut.data = data;
        totalCamerasDonut.update();
        return;
    }

    totalCamerasDonut = new Chart(ctx, {
        type: 'doughnut',
        data,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '72%',  // besar lubang tengah
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (tooltipItem) => {
                            const label = tooltipItem.label || '';
                            const value = tooltipItem.parsed || 0;
                            const p = total > 0
                                ? Math.round((value / total) * 100)
                                : 0;
                            return ` ${label}: ${value} kamera (${p}%)`;
                        }
                    }
                }
            }
        }
    });
}



// FETCH OFFLINE TREND DARI SERVER
async function fetchOfflineTrend(token) {
    try {
        const resp = await fetch('/api/offline-trend?days=7', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await resp.json();

        if (!resp.ok || !data.success) {
            console.warn('Gagal memuat offline trend:', data.message || resp.statusText);
            return;
        }

        updateOfflineTrendChart(data.points || []);

    } catch (err) {
        console.error('Error fetchOfflineTrend:', err);
    }
}

// =============================
//  HELPER DETAIL KAMERA
// =============================

function getCameraImageForType(type) {
    const base = 'lib/';
    if (!type) return base + 'logo-imip-full.png';
    const trimmed = type.toString().trim();
    return base + trimmed + '.png';
}

function formatDateTime(dtString) {
    if (!dtString) return 'Belum pernah';
    const d = new Date(dtString);
    if (Number.isNaN(d.getTime())) return dtString;
    return d.toLocaleString('id-ID', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function showCameraDetail(camera, rowElement) {
    const section = document.getElementById('cameraDetailSection');
    if (!section || !camera) return;

    selectedCameraId = camera.camera_id;
    selectedCameraData = camera;

    const imgEl = document.getElementById('cameraDetailImage');
    const typeLabelEl = document.getElementById('cameraDetailTypeLabel');
    const nameEl = document.getElementById('cameraDetailName');
    const statusEl = document.getElementById('cameraDetailStatus');
    const locEl = document.getElementById('cameraDetailLocation');
    const ipEl = document.getElementById('cameraDetailIP');
    const macEl = document.getElementById('cameraDetailMAC');
    const brandTypeEl = document.getElementById('cameraDetailBrandType');
    const coordsEl = document.getElementById('cameraDetailCoords');
    const lastSeenEl = document.getElementById('cameraDetailLastSeen');
    const lastCheckEl = document.getElementById('cameraDetailLastCheck');

    const type = camera.type || 'N/A';
    const brand = camera.cctv_brand || '';
    const location = camera.location || camera.area || 'N/A';
    const rawStatus = (camera.status || 'offline').toLowerCase();
    const normalizedStatus = rawStatus === 'error' ? 'offline' : rawStatus;
    const statusLabel = normalizedStatus === 'online' ? 'ONLINE' : 'OFFLINE';

    if (imgEl) {
        imgEl.onerror = () => {
            imgEl.onerror = null;
            imgEl.src = 'lib/logo-imip-full.png';
        };
        imgEl.src = getCameraImageForType(type);
    }

    if (typeLabelEl) typeLabelEl.textContent = type;
    if (nameEl) nameEl.textContent = camera.name || 'Tanpa nama';
    if (statusEl) {
        statusEl.textContent = statusLabel;
        statusEl.className = 'status-badge ' + normalizedStatus;
    }
    if (locEl) locEl.textContent = 'Lokasi: ' + location;
    if (ipEl) ipEl.textContent = camera.ip_address || '-';
    if (macEl) macEl.textContent = camera.mac_address || '-';

    if (brandTypeEl) {
        const brandPart = brand ? brand + ' – ' : '';
        brandTypeEl.textContent = brandPart + type;
    }

    if (coordsEl) {
        const lat = (camera.latitude || '').toString().trim();
        const lon = (camera.longitude || '').toString().trim();

        if (lat && lon) {
            const query = `${lat},${lon}`;
            const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
            coordsEl.innerHTML = `<a href="${url}" target="_blank" rel="noopener" class="coords-link">${lat}, ${lon}</a>`;
        } else if (lat || lon) {
            coordsEl.textContent = lat || lon;
        } else {
            coordsEl.textContent = '-';
        }
    }

    if (lastSeenEl) lastSeenEl.textContent = 'Terakhir online: ' + formatDateTime(camera.last_seen);
    if (lastCheckEl) lastCheckEl.textContent = 'Terakhir dicek: ' + formatDateTime(camera.last_check);

    section.classList.remove('hidden');

    const rows = document.querySelectorAll('#cameraTable tbody tr');
    rows.forEach(r => r.classList.remove('selected-row'));
    if (rowElement) rowElement.classList.add('selected-row');
}


// =============================
//  KAMERA: TABEL + FILTER
// =============================

function renderCameraTable(cameras) {
    const tableBody = document.getElementById('cameraTableBody');
    if (!tableBody) return;

    tableBody.innerHTML = '';

    if (!cameras || cameras.length === 0) {
        tableBody.innerHTML =
            '<tr><td colspan="8" class="text-center">Tidak ada data kamera yang cocok dengan filter.</td></tr>';
        return;
    }

    cameras.forEach(camera => {
        const row = tableBody.insertRow();
        row.dataset.cameraId = String(camera.camera_id);

        if (changedCameraIds.has(camera.camera_id)) {
            row.classList.add('status-changed');
        }

        const rawStatus = (camera.status || 'offline').toLowerCase();
        const normalizedStatus = rawStatus === 'error' ? 'offline' : rawStatus;
        const statusLabel = normalizedStatus === 'online' ? 'ONLINE' : 'OFFLINE';
        const statusDisplay =
            `<span class="status-badge ${normalizedStatus}">${statusLabel}</span>`;

        const lat = (camera.latitude || '').toString().trim();
        const lon = (camera.longitude || '').toString().trim();

        let coordCell = '-';
        if (lat && lon) {
            const query = `${lat},${lon}`;
            const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
            coordCell = `<a href="${url}" target="_blank" rel="noopener" class="coords-link">${lat}, ${lon}</a>`;
        } else if (lat || lon) {
            coordCell = lat || lon;
        }

        row.innerHTML = `
            <td>${camera.cctv_brand || '-'}</td> 
            <td>${camera.type || 'N/A'}</td>
            <td>${camera.name || 'N/A'}</td>
            <td>${camera.location || 'N/A'}</td>
            <td>${camera.ip_address || 'N/A'}</td>
            <td>${coordCell}</td>
            <td>${statusDisplay}</td>
            <td>${camera.mac_address || 'N/A'}</td>
        `;

        row.addEventListener('click', () => {
            showCameraDetail(camera, row);
        });
    });
}

// =============================
//  LIVE VIEW: RTSP LIST
// =============================

// Hanya perangkat yang dianggap kamera (punya RTSP) yang boleh live
function isRtspCapable(cam) {
    if (!cam) return false;
    if (!cam.ip_address) return false; // wajib punya IP

    // Gabungkan beberapa field untuk dicek
    const type = (cam.type || '').toLowerCase();
    const name = (cam.name || '').toLowerCase();
    const brand = (cam.cctv_brand || '').toLowerCase();
    const combined = `${type} ${name} ${brand}`;

    // Kata kunci perangkat NON‑kamera (bisa kamu tambah sendiri)
    const nonCameraKeywords = [
        'switch',
        'mrw',
        'lan',
        'keyboard ',
        'radio',
        'notebook',
        'access point',
        'ap',
        'sta',
        'st',
        'router',
        'mikrotik',
        'ubnt',
        'litebeam',
        'nanostation',
        'nvr',
        'dvr',
        'pc',
        'desktop',
        'laptop'
    ];

    // Jika mengandung kata kunci non‑kamera → anggap tidak ada RTSP
    return !nonCameraKeywords.some(kw => combined.includes(kw));
}

function getLiveTotalPages() {
    const total = liveFilteredCameras ? liveFilteredCameras.length : 0;
    return total > 0 ? Math.ceil(total / LIVE_PAGE_SIZE) : 1;
}

function buildRtspUrlForCamera(cam) {
    if (!isRtspCapable(cam)) return null;

    if (!ip) return null;

    const user = encodeURIComponent(RTSP_USERNAME);
    const pass = encodeURIComponent(RTSP_PASSWORD);
    return `rtsp://${user}:${pass}@${ip}:${RTSP_PORT}${RTSP_PATH}`;
}

function updateLiveActiveInfo(cameraId) {
    const nameEl = document.getElementById('liveActiveName');
    const locEl = document.getElementById('liveActiveLocation');
    if (!nameEl || !locEl) return;

    const cam = (allCameras || []).find(c => c.camera_id === cameraId);
    if (!cam) {
        nameEl.textContent = 'Belum ada kamera aktif';
        locEl.textContent = '';
        return;
    }

    const displayName = cam.name || '(Tanpa nama)';
    const displayLoc = cam.location || cam.area || '-';

    nameEl.textContent = displayName;
    locEl.textContent = displayLoc;
}

///LIVE CAMERA
function renderLiveCameraList(cameras) {
    const tbody = document.getElementById('liveTableBody');
    if (!tbody) return;

    let list = Array.isArray(cameras) ? cameras : (liveFilteredCameras || []);

    if (!list || !list.length) {
        tbody.innerHTML =
            '<tr><td colspan="4" class="text-center">Tidak ada kamera.</td></tr>';
        return;
    }

    // Sort: pertama berdasarkan lokasi, lalu berdasar kolom yang dipilih (name/ip)
    list = [...list].sort((a, b) => {
        const locA = (a.location || a.area || '').toLowerCase();
        const locB = (b.location || b.area || '').toLowerCase();
        if (locA < locB) return -1;
        if (locA > locB) return 1;

        let va, vb;
        if (liveSortField === 'ip') {
            va = (a.ip_address || '').toLowerCase();
            vb = (b.ip_address || '').toLowerCase();
        } else {
            // default: nama kamera
            va = (a.name || '').toLowerCase();
            vb = (b.name || '').toLowerCase();
        }

        if (va < vb) return liveSortDir === 'asc' ? -1 : 1;
        if (va > vb) return liveSortDir === 'asc' ? 1 : -1;
        return 0;
    });

    tbody.innerHTML = '';

    let currentLocKey = null;

    list.forEach(cam => {
        const displayLoc = cam.location || cam.area || 'Lokasi tidak diketahui';
        const locKey = displayLoc.toLowerCase();

        // Jika ganti lokasi → sisipkan baris header lokasi
        if (locKey !== currentLocKey) {
            currentLocKey = locKey;

            const groupRow = tbody.insertRow();
            groupRow.className = 'live-group-row';
            groupRow.innerHTML = `
                <td colspan="4">
                    <span class="live-group-title">${displayLoc}</span>
                </td>
            `;
        }

        const row = tbody.insertRow();
        row.innerHTML = `
            <td>${cam.name || 'N/A'}</td>
            <td>${displayLoc}</td>
            <td>${cam.ip_address || '-'}</td>
            <td style="text-align:center;">
                ${cam.ip_address
                ? `<button class="camera-action-btn live-start-btn"
                                data-id="${cam.camera_id}">
                           Live
                       </button>`
                : '<span style="font-size:0.8rem;color:#9ca3af;">IP kosong</span>'
            }
            </td>
        `;
    });

    // Event tombol Live
    const buttons = tbody.querySelectorAll('.live-start-btn');
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            const id = parseInt(btn.dataset.id, 10);
            if (id) startLiveForCamera(id);
        });
    });
}

function applyLiveFiltersAndRender() {
    const tbody = document.getElementById('liveTableBody');
    if (!tbody) return; // kalau bukan di live.html, keluar

    const searchInput = document.getElementById('liveSearchInput');
    const term = (searchInput?.value || '').trim().toLowerCase();

    // Hanya perangkat yang punya RTSP (kamera)
    let list = (allCameras || []).filter(isRtspCapable);

    // Filter teks (nama / lokasi / IP)
    if (term) {
        list = list.filter(cam => {
            const name = (cam.name || '').toLowerCase();
            const loc = (cam.location || cam.area || '').toLowerCase();
            const ip = (cam.ip_address || '').toLowerCase();
            return (
                name.includes(term) ||
                loc.includes(term) ||
                ip.includes(term)
            );
        });
    }

    // Simpan list full untuk pagination & sorting
    liveFilteredCameras = list;
    const total = list.length;

    if (total === 0) {
        renderLiveCameraList([]);
        updateLivePaginationControls(0);
        return;
    }

    const totalPages = getLiveTotalPages();
    if (liveCurrentPage > totalPages) liveCurrentPage = totalPages;
    if (liveCurrentPage < 1) liveCurrentPage = 1;

    const startIdx = (liveCurrentPage - 1) * LIVE_PAGE_SIZE;
    const pageSlice = list.slice(startIdx, startIdx + LIVE_PAGE_SIZE);

    renderLiveCameraList(pageSlice);
    updateLivePaginationControls(total);
}

function updateLivePaginationControls(total) {
    const infoEl = document.getElementById('livePageInfo');
    const prevBtn = document.getElementById('livePrevPage');
    const nextBtn = document.getElementById('liveNextPage');
    if (!infoEl || !prevBtn || !nextBtn) return;

    if (total === 0) {
        infoEl.textContent = 'Tidak ada kamera';
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        return;
    }

    const totalPages = getLiveTotalPages();
    const start = (liveCurrentPage - 1) * LIVE_PAGE_SIZE + 1;
    const end = Math.min(start + LIVE_PAGE_SIZE - 1, total);

    infoEl.textContent =
        `Halaman ${liveCurrentPage} dari ${totalPages} — ${start}-${end} dari ${total} kamera`;

    prevBtn.disabled = liveCurrentPage <= 1;
    nextBtn.disabled = liveCurrentPage >= totalPages;
}

function setupLiveSearch() {
    const searchInput = document.getElementById('liveSearchInput');
    if (!searchInput) return;

    searchInput.addEventListener('input', () => {
        liveCurrentPage = 1;
        applyLiveFiltersAndRender();
    });
}

function setupLiveSorting() {
    const headerCells = document.querySelectorAll('#liveTable thead th.live-sortable');
    if (!headerCells.length) return;

    headerCells.forEach(th => {
        th.addEventListener('click', () => {
            const field = th.dataset.sort; // 'name' atau 'ip'
            if (!field) return;

            if (liveSortField === field) {
                // Klik ulang kolom yang sama → toggle asc/desc
                liveSortDir = liveSortDir === 'asc' ? 'desc' : 'asc';
            } else {
                // Pindah kolom → set field baru & arah default asc
                liveSortField = field;
                liveSortDir = 'asc';
            }

            // Reset ke halaman 1 untuk konsistensi
            liveCurrentPage = 1;

            // Update tampilan header (panah)
            const allSortable = document.querySelectorAll('#liveTable thead th.live-sortable');
            allSortable.forEach(cell => {
                cell.classList.remove('sorted-asc', 'sorted-desc');
            });
            th.classList.add(liveSortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');

            // Render ulang dengan sort baru
            applyLiveFiltersAndRender();
        });
    });

    // Set default indicator di kolom Nama Kamera
    const defaultTh = document.querySelector('#liveTable thead th[data-sort="name"]');
    if (defaultTh) {
        defaultTh.classList.add('sorted-asc');
    }
}

function setupLivePagination() {
    if (livePaginationInitialized) return;
    const prevBtn = document.getElementById('livePrevPage');
    const nextBtn = document.getElementById('liveNextPage');
    if (!prevBtn || !nextBtn) return;

    prevBtn.addEventListener('click', () => {
        if (liveCurrentPage <= 1) return;
        liveCurrentPage--;
        applyLiveFiltersAndRender();
    });

    nextBtn.addEventListener('click', () => {
        const totalPages = getLiveTotalPages();
        if (liveCurrentPage >= totalPages) return;
        liveCurrentPage++;
        applyLiveFiltersAndRender();
    });

    livePaginationInitialized = true;
}


let hlsInstance = null;

function playHlsStream(url) {
    const video = document.getElementById('livePlayer');
    const statusEl = document.getElementById('liveStatus');
    if (!video) return;

    // Reset instance lama
    if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
    }

    // Safari & beberapa browser bisa langsung play HLS
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        video.play().catch(err => console.error('Video play error:', err));
    } else if (window.Hls) {
        // Browser lain pakai hls.js
        hlsInstance = new Hls();
        hlsInstance.loadSource(url);
        hlsInstance.attachMedia(video);
        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
            video.play().catch(err => console.error('HLS play error:', err));
        });
        hlsInstance.on(Hls.Events.ERROR, (event, data) => {
            console.error('HLS error:', data);
            if (statusEl) {
                statusEl.textContent = 'Gagal memutar stream: ' + data.type;
                statusEl.className = 'settings-status error';
            }
        });
    } else {
        if (statusEl) {
            statusEl.textContent = 'Browser ini tidak mendukung HLS (butuh hls.js).';
            statusEl.className = 'settings-status error';
        }
    }
}

async function startLiveForCamera(cameraId) {
    const statusEl = document.getElementById('liveStatus');
    const token = localStorage.getItem('authToken');
    updateLiveActiveInfo(cameraId);

    if (!token) {
        alert('Sesi Anda berakhir. Silakan login kembali.');
        window.location.href = '/index.html';
        return;
    }

    if (statusEl) {
        statusEl.textContent = 'Memulai stream kamera...';
        statusEl.className = 'settings-status';
    }

    try {
        const resp = await fetch(`/api/live/start/${cameraId}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await resp.json();

        if (!resp.ok || !data.success) {
            if (statusEl) {
                statusEl.textContent = 'Gagal memulai stream: ' + (data.message || resp.statusText);
                statusEl.className = 'settings-status error';
            }
            return;
        }

        if (statusEl) {
            statusEl.textContent = 'Memutar live stream kamera...';
            statusEl.className = 'settings-status';
        }

        playHlsStream(data.hlsUrl);

    } catch (err) {
        console.error('Error startLiveForCamera:', err);
        if (statusEl) {
            statusEl.textContent = 'Kesalahan jaringan saat memulai stream.';
            statusEl.className = 'settings-status error';
        }
    }
}


function applyCameraFiltersAndRender() {
    if (!allCameras) return;

    const searchInput = document.getElementById('searchInput');
    const statusSelect = document.getElementById('statusFilter');
    const areaSelect = document.getElementById('areaFilter');

    const term = (searchInput?.value || '').trim().toLowerCase();
    const statusFilter = (statusSelect?.value || 'all').toLowerCase();
    const areaFilter = (areaSelect?.value || 'all').toLowerCase();

    const filtered = allCameras.filter(cam => {
        const rawStatus = (cam.status || 'offline').toLowerCase();
        const normalizedStatus = rawStatus === 'error' ? 'offline' : rawStatus;
        const location = (cam.location || '').toLowerCase();
        const brand = (cam.cctv_brand || '').toLowerCase();
        const type = (cam.type || '').toLowerCase();
        const name = (cam.name || '').toLowerCase();
        const ip = (cam.ip_address || '').toLowerCase();
        const mac = (cam.mac_address || '').toLowerCase();

        const statusOk =
            statusFilter === 'all' ||
            normalizedStatus === statusFilter;
        const areaOk = areaFilter === 'all' || location === areaFilter;

        const searchOk =
            !term ||
            brand.includes(term) ||
            type.includes(term) ||
            name.includes(term) ||
            location.includes(term) ||
            ip.includes(term) ||
            mac.includes(term);

        return statusOk && areaOk && searchOk;
    });

    renderCameraTable(filtered);
}

function populateAreaFilterOptions() {
    const areaSelect = document.getElementById('areaFilter');
    if (!areaSelect || !allCameras) return;

    const locations = new Set();
    allCameras.forEach(cam => {
        if (cam.location) locations.add(cam.location);
    });

    const currentValue = areaSelect.value || 'all';

    areaSelect.innerHTML = '<option value="all">Lokasi: Semua</option>';

    Array.from(locations)
        .sort((a, b) => a.localeCompare(b))
        .forEach(loc => {
            const opt = document.createElement('option');
            opt.value = loc.toLowerCase();
            opt.textContent = loc;
            areaSelect.appendChild(opt);
        });

    const existed = Array.from(areaSelect.options).some(o => o.value === currentValue);
    areaSelect.value = existed ? currentValue : 'all';
}


// =============================
//  NOTIFIKASI OFFLINE LAMA
// =============================

function renderTopOfflineTable(cameras) {
    const tbody = document.getElementById('topOfflineBody');
    if (!tbody) return; // kalau bukan di dashboard.html, langsung keluar

    if (!Array.isArray(cameras) || cameras.length === 0) {
        tbody.innerHTML =
            '<tr><td colspan="4" class="text-center">Tidak ada kamera offline melewati ambang waktu.</td></tr>';
        return;
    }

    // pastikan terurut dari offline terlama
    const sorted = [...cameras].sort(
        (a, b) => (b.offline_minutes || 0) - (a.offline_minutes || 0)
    );

    // Ambil maksimal 5 kamera
    const top = sorted.slice(0, 9);

    tbody.innerHTML = '';
    top.forEach(cam => {
        const row = tbody.insertRow();
        row.innerHTML = `
            <td>${cam.name || 'N/A'}</td>
            <td>${cam.location || 'N/A'}</td>
            <td>${cam.ip_address || '-'}</td>
            <td>${cam.offline_minutes}</td>
        `;
    });
}

async function fetchOfflineAlerts(token) {
    try {
        const response = await fetch('/api/offline-alerts', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const result = await response.json();

        const countSpan = document.getElementById('notifCount');
        const subtitle = document.getElementById('notificationsSubtitle');
        const tbody = document.getElementById('notificationsBody');

        if (countSpan) countSpan.textContent = '0';

        if (!response.ok || !result.success) {
            console.warn('Gagal memuat notifikasi offline:', result.message || response.statusText);
            if (subtitle) {
                subtitle.textContent = 'Gagal memuat data notifikasi.';
            }
            // kosongkan tabel kecil di dashboard
            renderTopOfflineTable([]);
            return;
        }

        if (countSpan) countSpan.textContent = result.count;

        if (!tbody) return;

        if (!result.cameras || result.cameras.length === 0) {
            tbody.innerHTML =
                '<tr><td colspan="4" class="text-center">Tidak ada kamera offline melebihi ambang waktu.</td></tr>';
            if (subtitle) {
                subtitle.textContent =
                    `Tidak ada kamera offline melewati ${result.thresholdMinutes} menit.`;
            }
            // update tabel kecil juga (tampilkan pesan kosong)
            renderTopOfflineTable([]);
            return;
        }

        if (subtitle) {
            subtitle.textContent =
                `Menampilkan kamera yang offline ≥ ${result.thresholdMinutes} menit.`;
        }

        tbody.innerHTML = '';
        result.cameras.forEach(cam => {
            const row = tbody.insertRow();
            row.innerHTML = `
                <td>${cam.name || 'N/A'}</td>
                <td>${cam.location || 'N/A'}</td>
                <td>${cam.ip_address || 'N/A'}</td>
                <td style="text-align:center;color:#f97373;font-weight:600">
                    ${cam.offline_minutes}
                </td>
            `;
        });

        // isi tabel kecil "Kamera Offline Lama (Top 5)" di dashboard
        renderTopOfflineTable(result.cameras);

    } catch (error) {
        console.error('Error fetching offline alerts:', error);
    }
}


// =============================
//  FETCH LIST KAMERA
// =============================

async function fetchCameraList(token) {
    try {
        const response = await fetch('/api/cameras-list', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
            const tableBody = document.getElementById('cameraTableBody');
            if (response.status === 401) {
                localStorage.removeItem('authToken');
                alert('Sesi Anda berakhir. Silakan login kembali.');
                window.location.href = '/index.html';
            } else if (tableBody) {
                tableBody.innerHTML =
                    '<tr><td colspan="8" class="text-center">Gagal memuat daftar kamera.</td></tr>';
            }
            return;
        }

        allCameras = result.cameras || [];

        const newStatusMap = {};
        const changedIds = new Set();

        allCameras.forEach(cam => {
            const currentStatus = (cam.status || 'offline').toLowerCase();
            const prevStatus = previousCameraStatus[cam.camera_id];

            if (prevStatus && prevStatus !== currentStatus) {
                changedIds.add(cam.camera_id);
            }
            newStatusMap[cam.camera_id] = currentStatus;
        });

        previousCameraStatus = newStatusMap;
        changedCameraIds = changedIds;

        populateAreaFilterOptions();
        applyCameraFiltersAndRender();

        // update tabel live view jika sedang di live.html
        applyLiveFiltersAndRender();

        // update peta di dashboard jika ada
        updateCameraMapFromAllCameras();

    } catch (error) {
        console.error('Error fetching camera list:', error);
        const tableBody = document.getElementById('cameraTableBody');
        if (tableBody) {
            tableBody.innerHTML =
                '<tr><td colspan="8" class="text-center">Kesalahan koneksi jaringan saat memuat data kamera.</td></tr>';
        }
    }
}


// =============================
//  DATA USER (WELCOME & RBAC)
// =============================

async function fetchUserData(token) {
    try {
        const response = await fetch('/api/user-data', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
            if (response.status === 401) {
                localStorage.removeItem('authToken');
                alert('Sesi Anda berakhir. Silakan login kembali.');
                window.location.href = '/index.html';
            } else {
                console.error('Gagal memuat data user:', data.message || response.statusText);
            }
            return null;
        }

        const welcomeEl = document.getElementById('welcomeMessage');
        if (welcomeEl) {
            welcomeEl.innerHTML = `
                Selamat Datang,
                <span class="accent-text">${data.user.username}</span>
                (Role: ${data.user.role})
            `;
        }

        const settingsLink = document.getElementById('settingsLink');
        if (settingsLink && data.user.role !== 'administrator') {
            settingsLink.style.display = 'none';
        }

        const usersNav = document.getElementById('usersNavLink');
        if (usersNav && data.user.role !== 'administrator') {
            usersNav.style.display = 'none';
        }

        return data.user;

    } catch (error) {
        console.error('Error fetching user data:', error);
        return null;
    }
}


// =============================
//  AUTO REFRESH
// =============================

function startAutoRefresh(token) {
    if (autoRefreshIntervalId) {
        clearInterval(autoRefreshIntervalId);
    }

    autoRefreshIntervalId = setInterval(async () => {
        await fetchMetrics(token);
        await fetchCameraList(token);
        await fetchOfflineAlerts(token);
    }, REFRESH_INTERVAL_MS);
}


// =============================
//  SETUP FILTER KAMERA & AKSI
// =============================

function setupCameraFilters() {
    if (filtersInitialized) return;
    filtersInitialized = true;

    const searchInput = document.getElementById('searchInput');
    const statusSelect = document.getElementById('statusFilter');
    const areaSelect = document.getElementById('areaFilter');
    const resetBtn = document.getElementById('resetFiltersBtn');

    if (searchInput) {
        searchInput.addEventListener('input', () => {
            applyCameraFiltersAndRender();
        });
    }

    if (statusSelect) {
        statusSelect.addEventListener('change', () => {
            applyCameraFiltersAndRender();
        });
    }

    if (areaSelect) {
        areaSelect.addEventListener('change', () => {
            applyCameraFiltersAndRender();
        });
    }

    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (searchInput) searchInput.value = '';
            if (statusSelect) statusSelect.value = 'all';
            if (areaSelect) areaSelect.value = 'all';
            applyCameraFiltersAndRender();
        });
    }
}

function setupExportButton() {
    const btn = document.getElementById('exportBtn');
    const searchInput = document.getElementById('searchInput');
    const statusSelect = document.getElementById('statusFilter');
    const areaSelect = document.getElementById('areaFilter');
    if (!btn) return;

    btn.addEventListener('click', () => {
        const token = localStorage.getItem('authToken');
        if (!token) {
            alert('Sesi Anda berakhir. Silakan login kembali.');
            window.location.href = '/index.html';
            return;
        }

        const search = encodeURIComponent((searchInput?.value || '').trim());
        const status = encodeURIComponent((statusSelect?.value || 'all'));
        const area = encodeURIComponent((areaSelect?.value || 'all'));
        const tokenParam = encodeURIComponent(token);

        const url =
            `/api/cameras-export?search=${search}` +
            `&status=${status}&area=${area}&token=${tokenParam}`;

        window.open(url, '_blank');
    });
}

function setupAddCameraForm(token, user) {
    const btn = document.getElementById('addCameraBtn');
    const modal = document.getElementById('addCameraModal');
    const backdrop = document.getElementById('addCameraBackdrop');
    const closeBtn = document.getElementById('closeAddCameraBtn');
    const cancelBtn = document.getElementById('addCameraCancel');
    const form = document.getElementById('addCameraForm');
    const statusEl = document.getElementById('addCameraStatus');

    if (!btn || !modal || !backdrop || !form) return;

    // Non-admin: sembunyikan tombol
    if (!user || user.role !== 'administrator') {
        btn.style.display = 'none';
        return;
    }

    const open = () => {
        modal.classList.remove('hidden');
        backdrop.classList.remove('hidden');
        form.reset();
        if (statusEl) {
            statusEl.textContent = '';
            statusEl.className = 'settings-status';
        }
    };

    const close = () => {
        modal.classList.add('hidden');
        backdrop.classList.add('hidden');
    };

    btn.addEventListener('click', open);
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (cancelBtn) cancelBtn.addEventListener('click', close);
    backdrop.addEventListener('click', close);

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const payload = {
            cctv_brand: document.getElementById('addCctvBrand')?.value.trim() || '',
            type: document.getElementById('addType')?.value.trim(),
            name: document.getElementById('addName')?.value.trim(),
            area: document.getElementById('addArea')?.value.trim(),
            ip_address: document.getElementById('addIP')?.value.trim() || '',
            mac_address: document.getElementById('addMAC')?.value.trim() || '',
            latitude: document.getElementById('addLat')?.value.trim() || '',
            longitude: document.getElementById('addLon')?.value.trim() || ''
        };

        if (!payload.type || !payload.name || !payload.area) {
            if (statusEl) {
                statusEl.textContent = 'Type, Nama, dan Area wajib diisi.';
                statusEl.className = 'settings-status error';
            }
            return;
        }

        if (statusEl) {
            statusEl.textContent = 'Menyimpan kamera...';
            statusEl.className = 'settings-status';
        }

        try {
            const resp = await fetch('/api/admin/cameras', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(payload)
            });

            const data = await resp.json();

            if (!resp.ok || !data.success) {
                if (statusEl) {
                    statusEl.textContent = 'Gagal menyimpan: ' + (data.message || resp.statusText);
                    statusEl.className = 'settings-status error';
                }
                return;
            }

            if (statusEl) {
                statusEl.textContent = 'Berhasil menambahkan kamera.';
                statusEl.className = 'settings-status success';
            }

            await fetchCameraList(token);
            setTimeout(close, 800);

        } catch (err) {
            console.error('Error add camera:', err);
            if (statusEl) {
                statusEl.textContent = 'Kesalahan jaringan saat menyimpan.';
                statusEl.className = 'settings-status error';
            }
        }
    });
}

//SETUP KAMERA//=======

function setupDeleteCamera(token, user) {
    const btn = document.getElementById('deleteCameraBtn');
    if (!btn) return;

    // Hanya admin yang boleh menghapus
    if (!user || user.role !== 'administrator') {
        btn.style.display = 'none';
        return;
    }

    btn.addEventListener('click', async () => {
        if (!selectedCameraId) {
            alert('Pilih kamera terlebih dahulu dari tabel.');
            return;
        }

        const yakin = confirm('Yakin ingin menghapus kamera ini dari database?');
        if (!yakin) return;

        try {
            const resp = await fetch(`/api/admin/cameras/${selectedCameraId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await resp.json();

            if (!resp.ok || !data.success) {
                alert('Gagal menghapus kamera: ' + (data.message || resp.statusText));
                return;
            }

            alert('Kamera berhasil dihapus.');

            await fetchCameraList(token);
            const section = document.getElementById('cameraDetailSection');
            if (section) section.classList.add('hidden');
            selectedCameraId = null;

        } catch (err) {
            console.error('Error delete camera:', err);
            alert('Kesalahan jaringan saat menghapus kamera.');
        }
    });
}

function setupEditCamera(token, user) {
    const btn = document.getElementById('editCameraBtn');
    const modal = document.getElementById('editCameraModal');
    const backdrop = document.getElementById('editCameraBackdrop');
    const closeBtn = document.getElementById('closeEditCameraBtn');
    const cancelBtn = document.getElementById('editCameraCancel');
    const form = document.getElementById('editCameraForm');
    const statusEl = document.getElementById('editCameraStatus');

    if (!btn || !modal || !backdrop || !form) return;

    // Hanya admin yang boleh edit
    if (!user || user.role !== 'administrator') {
        btn.style.display = 'none';
        return;
    }

    const open = () => {
        if (!selectedCameraData) {
            alert('Pilih kamera terlebih dahulu dari tabel.');
            return;
        }

        const cam = selectedCameraData;

        document.getElementById('editCctvBrand').value = cam.cctv_brand || '';
        document.getElementById('editType').value = cam.type || '';
        document.getElementById('editName').value = cam.name || '';
        document.getElementById('editArea').value = cam.location || cam.area || '';
        document.getElementById('editIP').value = cam.ip_address || '';
        document.getElementById('editMAC').value = cam.mac_address || '';
        document.getElementById('editLat').value = cam.latitude || '';
        document.getElementById('editLon').value = cam.longitude || '';

        if (statusEl) {
            statusEl.textContent = '';
            statusEl.className = 'settings-status';
        }

        modal.classList.remove('hidden');
        backdrop.classList.remove('hidden');
    };

    const close = () => {
        modal.classList.add('hidden');
        backdrop.classList.add('hidden');
    };

    btn.addEventListener('click', open);
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (cancelBtn) cancelBtn.addEventListener('click', close);
    backdrop.addEventListener('click', close);

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!selectedCameraId) {
            if (statusEl) {
                statusEl.textContent = 'Tidak ada kamera terpilih.';
                statusEl.className = 'settings-status error';
            }
            return;
        }

        const payload = {
            cctv_brand: document.getElementById('editCctvBrand')?.value.trim() || '',
            type: document.getElementById('editType')?.value.trim(),
            name: document.getElementById('editName')?.value.trim(),
            area: document.getElementById('editArea')?.value.trim(),
            ip_address: document.getElementById('editIP')?.value.trim() || '',
            mac_address: document.getElementById('editMAC')?.value.trim() || '',
            latitude: document.getElementById('editLat')?.value.trim() || '',
            longitude: document.getElementById('editLon')?.value.trim() || ''
        };

        if (!payload.type || !payload.name || !payload.area) {
            if (statusEl) {
                statusEl.textContent = 'Type, Nama, dan Area wajib diisi.';
                statusEl.className = 'settings-status error';
            }
            return;
        }

        if (statusEl) {
            statusEl.textContent = 'Menyimpan perubahan...';
            statusEl.className = 'settings-status';
        }

        try {
            const resp = await fetch(`/api/admin/cameras/${selectedCameraId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(payload)
            });

            const data = await resp.json();

            if (!resp.ok || !data.success) {
                if (statusEl) {
                    statusEl.textContent = 'Gagal menyimpan: ' + (data.message || resp.statusText);
                    statusEl.className = 'settings-status error';
                }
                return;
            }

            if (statusEl) {
                statusEl.textContent = 'Perubahan berhasil disimpan.';
                statusEl.className = 'settings-status success';
            }

            // Refresh daftar kamera & detail
            await fetchCameraList(token);

            const updatedCam = allCameras.find(c => c.camera_id === selectedCameraId);
            const row = document.querySelector(
                `#cameraTable tbody tr[data-camera-id="${selectedCameraId}"]`
            );

            if (updatedCam) {
                showCameraDetail(updatedCam, row || null);
            }

            setTimeout(close, 800);

        } catch (err) {
            console.error('Error edit camera:', err);
            if (statusEl) {
                statusEl.textContent = 'Kesalahan jaringan saat menyimpan.';
                statusEl.className = 'settings-status error';
            }
        }
    });
}

// =============================
//  USER MANAGEMENT (USERS.HTML)
// =============================

async function fetchUsers(token) {
    try {
        const resp = await fetch('/api/admin/users', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await resp.json();
        if (!resp.ok || !data.success) {
            console.error('Gagal memuat daftar user:', data.message || resp.statusText);
            return [];
        }
        return data.users || [];
    } catch (err) {
        console.error('Error fetchUsers:', err);
        return [];
    }
}

function renderUsers(users, currentUser) {
    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;

    if (!users || users.length === 0) {
        tbody.innerHTML =
            '<tr><td colspan="4" class="text-center">Tidak ada user terdaftar.</td></tr>';
        return;
    }

    tbody.innerHTML = '';

    users.forEach(u => {
        const row = tbody.insertRow();
        const isSelf = currentUser && u.user_id === currentUser.user_id;

        row.innerHTML = `
            <td>${u.username}</td>
            <td>${u.nama_lengkap || '-'}</td>
            <td>${u.role}</td>
            <td style="text-align:center;">
                ${isSelf
                ? '<span style="font-size:0.75rem;color:#9ca3af;">(akun sendiri)</span>'
                : `<button class="icon-btn danger user-delete-btn" data-id="${u.user_id}" title="Hapus user">
                        <i class='bx bx-trash'></i>
                   </button>`}
            </td>
        `;
    });
}

async function initUsersPage(token) {
    const user = await fetchUserData(token);
    if (!user || user.role !== 'administrator') {
        alert('Halaman Users hanya dapat diakses oleh administrator.');
        window.location.href = '/dashboard';
        return;
    }

    const form = document.getElementById('addUserForm');
    const statusEl = document.getElementById('addUserStatus');

    const loadUsers = async () => {
        const users = await fetchUsers(token);
        renderUsers(users, user);

        // tombol delete
        const buttons = document.querySelectorAll('.user-delete-btn');
        buttons.forEach(btn => {
            btn.addEventListener('click', async () => {
                const targetId = parseInt(btn.dataset.id, 10);
                const yakin = confirm('Yakin ingin menghapus user ini?');
                if (!yakin) return;

                try {
                    const resp = await fetch(`/api/admin/users/${targetId}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    const data = await resp.json();
                    if (!resp.ok || !data.success) {
                        alert('Gagal menghapus: ' + (data.message || resp.statusText));
                        return;
                    }
                    await loadUsers();
                } catch (err) {
                    console.error('Error delete user:', err);
                    alert('Kesalahan jaringan saat menghapus user.');
                }
            });
        });
    };

    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();

            const username = document.getElementById('addUsername')?.value.trim();
            const namaLengkap = document.getElementById('addFullname')?.value.trim() || null;
            const role = document.getElementById('addRole')?.value || 'viewer';
            const password = document.getElementById('addPassword')?.value;

            if (!username || !password) {
                if (statusEl) {
                    statusEl.textContent = 'Username dan Password wajib diisi.';
                    statusEl.className = 'settings-status error';
                }
                return;
            }

            if (password.length < 6) {
                if (statusEl) {
                    statusEl.textContent = 'Password minimal 6 karakter.';
                    statusEl.className = 'settings-status error';
                }
                return;
            }

            if (statusEl) {
                statusEl.textContent = 'Menyimpan user...';
                statusEl.className = 'settings-status';
            }

            try {
                const resp = await fetch('/api/admin/users', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        username,
                        password,
                        role,
                        nama_lengkap: namaLengkap
                    })
                });

                const data = await resp.json();
                if (!resp.ok || !data.success) {
                    if (statusEl) {
                        statusEl.textContent = 'Gagal menyimpan: ' + (data.message || resp.statusText);
                        statusEl.className = 'settings-status error';
                    }
                    return;
                }

                if (statusEl) {
                    statusEl.textContent = 'User berhasil ditambahkan.';
                    statusEl.className = 'settings-status success';
                }

                form.reset();
                await loadUsers();

            } catch (err) {
                console.error('Error add user:', err);
                if (statusEl) {
                    statusEl.textContent = 'Kesalahan jaringan saat menyimpan user.';
                    statusEl.className = 'settings-status error';
                }
            }
        });
    }

    await loadUsers();
}


// =============================
//  INIT PER HALAMAN
// =============================

async function initHomeDashboard(token) {
    await Promise.all([
        fetchUserData(token),
        fetchMetrics(token),
        fetchOfflineAlerts(token),
        fetchOfflineTrend(token),
        fetchCameraList(token)           // ambil data kamera (untuk peta)
    ]);

    initCameraMap();                    // inisialisasi peta dengan allCameras
    startAutoRefresh(token);
}

async function initCameraPage(token) {
    const user = await fetchUserData(token);
    await Promise.all([
        fetchCameraList(token),
        fetchMetrics(token)
    ]);
    setupCameraFilters();
    setupExportButton();
    setupAddCameraForm(token, user);
    setupEditCamera(token, user);
    setupDeleteCamera(token, user);
    startAutoRefresh(token);
}

async function initLivePage(token) {
    await fetchUserData(token);
    await fetchCameraList(token);   // isi allCameras

    setupLiveSearch();
    setupLivePagination();
    setupLiveSorting();

    liveCurrentPage = 1;
    applyLiveFiltersAndRender();
    // startAutoRefresh(token); // optional
}

async function initRekapPage(token) {
    await Promise.all([
        fetchUserData(token),
        fetchMetrics(token)
    ]);
    startAutoRefresh(token);
}

async function initSettingsPage(token) {
    const user = await fetchUserData(token);

    if (!user || user.role !== 'administrator') {
        alert('Halaman Settings hanya dapat diakses oleh administrator.');
        window.location.href = '/dashboard';
        return;
    }

    const form = document.getElementById('importForm');
    const fileInput = document.getElementById('excelFile');
    const statusEl = document.getElementById('importStatus');

    if (!form || !fileInput) return;

    form.addEventListener('submit', async (event) => {
        event.preventDefault();

        if (!fileInput.files || !fileInput.files.length) {
            alert('Pilih file Excel terlebih dahulu.');
            return;
        }

        const file = fileInput.files[0];
        const formData = new FormData();
        formData.append('file', file);

        if (statusEl) {
            statusEl.textContent = 'Mengupload & memproses data...';
            statusEl.className = 'settings-status';
        }

        try {
            const response = await fetch('/api/admin/import-cameras', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                body: formData
            });

            const data = await response.json();

            if (!response.ok || !data.success) {
                if (statusEl) {
                    statusEl.textContent = 'Gagal: ' + (data.message || response.statusText);
                    statusEl.className = 'settings-status error';
                }
                return;
            }

            if (statusEl) {
                statusEl.textContent = `Berhasil import ${data.inserted} kamera. ` +
                    `Silakan buka Daftar Kamera atau Rekap Lokasi untuk melihat data terbaru.`;
                statusEl.className = 'settings-status success';
            }

        } catch (error) {
            console.error('Error saat import kamera:', error);
            if (statusEl) {
                statusEl.textContent = 'Kesalahan jaringan saat import data.';
                statusEl.className = 'settings-status error';
            }
        }
    });
}


// =============================
//  LOGIN + ROUTING HALAMAN
// =============================

document.addEventListener('DOMContentLoaded', function () {
    const path = window.location.pathname;

    const loginForm = document.getElementById('loginForm');
    const logoutButton = document.getElementById('logoutButton');

    // LOGIN PAGE
    // LOGIN PAGE
if (loginForm) {
    loginForm.addEventListener('submit', async function (event) {
        event.preventDefault();

        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;

        // Tampilkan popup loading
        showSystemModal(
            'Memeriksa akun...',
            'Mohon tunggu sebentar, kami sedang memverifikasi kredensial Anda.',
            'loading'
        );

        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            const data = await response.json();

            if (!response.ok || !data.success || !data.token) {
                updateSystemModal(
                    'Login gagal',
                    data.message || 'Username atau password salah.',
                    'error'
                );
                setTimeout(hideSystemModal, 1600);
                return;
            }

            // Simpan token & tampilkan sukses
            localStorage.setItem('authToken', data.token);

            updateSystemModal(
                'Login berhasil',
                'Mengarahkan ke dashboard...',
                'success'
            );

            setTimeout(() => {
                window.location.href = '/dashboard';
            }, 900);

        } catch (error) {
            console.error('Error saat mengirim request login:', error);
            updateSystemModal(
                'Koneksi gagal',
                'Tidak dapat menghubungi server. Pastikan server Node.js berjalan.',
                'error'
            );
            setTimeout(hideSystemModal, 1800);
        }
    });
}
// LOGOUT
if (logoutButton) {
    logoutButton.addEventListener('click', function () {
        localStorage.removeItem('authToken');

        showSystemModal(
            'Logout',
            'Anda berhasil logout. Mengarahkan ke halaman login...',
            'success'
        );

        setTimeout(() => {
            window.location.href = '/index.html';
        }, 900);
    });
}

    // Halaman login tidak perlu token & init lain
    const isLoginPage = path === '/' || path.endsWith('/index.html');
    if (isLoginPage) return;

    const token = localStorage.getItem('authToken');
    if (!token) {
        alert('Sesi Anda berakhir atau Token tidak ditemukan. Silakan login kembali.');
        window.location.href = '/index.html';
        return;
    }


    // TOMBOL LIVE VIEW DI DASHBOARD
    const liveViewBtn = document.getElementById('liveViewBtn');
    if (liveViewBtn) {
        liveViewBtn.addEventListener('click', () => {
            window.location.href = '/live.html';
        });
    }

    // EVENT MODAL NOTIFIKASI (Dashboard)
    const notificationsBtn = document.getElementById('notificationsBtn');
    const notifModal = document.getElementById('notificationsModal');
    const modalBackdrop = document.getElementById('modalBackdrop');
    const closeNotifBtn = document.getElementById('closeNotificationsBtn');

    function openNotifModal() {
        if (!notifModal || !modalBackdrop) return;
        notifModal.classList.remove('hidden');
        modalBackdrop.classList.remove('hidden');
    }

    function closeNotifModal() {
        if (!notifModal || !modalBackdrop) return;
        notifModal.classList.add('hidden');
        modalBackdrop.classList.add('hidden');
    }

    if (notificationsBtn && notifModal && modalBackdrop) {
        notificationsBtn.addEventListener('click', openNotifModal);
    }

    if (closeNotifBtn) {
        closeNotifBtn.addEventListener('click', closeNotifModal);
    }

    if (modalBackdrop && notifModal) {
        modalBackdrop.addEventListener('click', closeNotifModal);
    }



    // ROUTING PER HALAMAN
    if (path === '/dashboard' || path.endsWith('/dashboard.html')) {
        initHomeDashboard(token);
    } else if (path.endsWith('/cameras.html') || path === '/cameras') {
        initCameraPage(token);
    } else if (path.endsWith('/live.html') || path === '/live') {
        initLivePage(token);
    } else if (path.endsWith('/rekap.html') || path === '/rekap') {
        initRekapPage(token);
    } else if (path.endsWith('/settings.html') || path === '/settings') {
        initSettingsPage(token);
    } else if (path.endsWith('/users.html') || path === '/users') {
        initUsersPage(token);
    }
});