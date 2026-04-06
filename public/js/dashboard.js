/**
 * Austra Dashboard — Super App Home Screen
 * Fetches data from /dashboard/data (server-side aggregated) and individual APIs.
 */

'use strict';

/* ── State ── */
let dashboardData      = null;
let exchangeRates      = {};
let btcUpdateInterval  = null;
let clockInterval      = null;

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
    initClock();
    loadDashboard();
    loadWeatherWidget();
    loadExchangeRatesWidget();
    loadNewsWidget();

    // Currency converter listeners
    const fromAmount   = document.getElementById('fromAmount');
    const fromCurrency = document.getElementById('fromCurrency');
    const toCurrency   = document.getElementById('toCurrency');
    if (fromAmount)   fromAmount.addEventListener('input', performConversion);
    if (fromCurrency) fromCurrency.addEventListener('change', performConversion);
    if (toCurrency)   toCurrency.addEventListener('change', performConversion);

    // AI quick input — enter key
    const aiInput = document.getElementById('aiQuickInput');
    if (aiInput) {
        aiInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') sendQuickAIMessage();
        });
    }

    // Close modals on backdrop click
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('active');
        });
    });
});

window.addEventListener('beforeunload', () => {
    if (btcUpdateInterval) clearInterval(btcUpdateInterval);
    if (clockInterval)     clearInterval(clockInterval);
});

/* ============================================================
   CLOCK
   ============================================================ */
function initClock() {
    updateClock();
    clockInterval = setInterval(updateClock, 1000);
}

function updateClock() {
    const el = document.getElementById('currentDateTime');
    if (!el) return;

    const now = new Date();
    const opts = {
        weekday: 'short', day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit',
        timeZone: 'America/Montevideo'
    };

    try {
        el.textContent = now.toLocaleString('es-UY', opts);
    } catch (_) {
        el.textContent = now.toLocaleString('es-UY');
    }
}

/* ============================================================
   GREETING
   ============================================================ */
function setGreeting(name) {
    const greetingName = document.getElementById('greetingName');
    const greetingSub  = document.getElementById('greetingTime');
    if (greetingName) greetingName.textContent = name || 'Usuario';

    if (greetingSub) {
        const h = new Date().getHours();
        let msg;
        if (h >= 5  && h < 12) msg = 'Buenos días';
        else if (h >= 12 && h < 19) msg = 'Buenas tardes';
        else msg = 'Buenas noches';
        greetingSub.textContent = msg;
    }
}

/* ============================================================
   MAIN DASHBOARD DATA  (/dashboard/data)
   ============================================================ */
async function loadDashboard() {
    try {
        const res    = await fetch('/dashboard/data', { credentials: 'include' });
        const result = await res.json();

        if (!result.success) {
            console.error('Dashboard data error:', result.error);
            return;
        }

        dashboardData = result.data;

        // Greeting
        setGreeting(dashboardData.user?.name);

        // Avatar
        loadAvatar(dashboardData.user?.picture);

        // Notification badge
        const badge = document.getElementById('notifBadge');
        if (badge) {
            const count = dashboardData.unreadNotificationsCount || 0;
            badge.textContent = count;
            badge.style.display = count > 0 ? 'flex' : 'none';
        }

        // BCU rates (from dashboard data, feeds converter + cotizaciones widget)
        if (dashboardData.bcuRates) {
            applyBcuRates(dashboardData.bcuRates);
        }

        // Bitcoin
        if (dashboardData.bitcoinData) {
            renderBitcoin(dashboardData.bitcoinData);
        }
        startBtcAutoUpdate();

        // Forum threads
        renderForumWidget(dashboardData.forumThreads || []);

        // Centinel alerts
        renderCentinelWidget(dashboardData.incidents || []);

        // Profile widget
        renderProfileWidget(dashboardData.user);

    } catch (err) {
        console.error('Error loading dashboard:', err);
    }
}

/* ── Avatar ── */
function loadAvatar(src) {
    const img     = document.getElementById('userAvatar');
    const spinner = document.getElementById('avatarSpinner');
    if (!img) return;

    const url = src || '/images/default-avatar.png';
    const temp = new Image();

    temp.onload = () => {
        img.src = url;
        img.classList.add('loaded');
        if (spinner) spinner.classList.add('hidden');
    };
    temp.onerror = () => {
        img.src = '/images/default-avatar.png';
        img.classList.add('loaded');
        if (spinner) spinner.classList.add('hidden');
    };
    temp.src = url;
}

/* ============================================================
   WEATHER WIDGET  (/weather)
   ============================================================ */
async function loadWeatherWidget() {
    try {
        const res    = await fetch('/weather', { credentials: 'include' });
        const result = await res.json();

        if (!result.success || !result.data) return;

        const weather = result.data;
        renderWeatherWidget(weather);
    } catch (err) {
        console.error('Error loading weather:', err);
        const emojiEl = document.getElementById('climaEmoji');
        const descEl  = document.getElementById('climaDesc');
        if (emojiEl) emojiEl.textContent = '🌦️';
        if (descEl)  descEl.textContent  = 'No disponible';
    }
}

function renderWeatherWidget(weather) {
    const current = weather.current;
    if (!current) return;

    const emojiEl    = document.getElementById('climaEmoji');
    const tempEl     = document.getElementById('climaTemp');
    const descEl     = document.getElementById('climaDesc');
    const humidEl    = document.getElementById('climaHumidity');
    const windEl     = document.getElementById('climaWind');
    const feelsEl    = document.getElementById('climaFeels');
    const forecastEl = document.getElementById('climaForecast');

    if (emojiEl)  emojiEl.textContent  = getWeatherEmoji(current.weather_code);
    if (tempEl)   tempEl.textContent   = `${Math.round(current.temperature)}°`;
    if (descEl)   descEl.textContent   = current.description || '';
    if (humidEl)  humidEl.textContent  = `Humedad ${current.humidity}%`;
    if (windEl)   windEl.textContent   = `Viento ${Math.round(current.wind)} km/h`;
    if (feelsEl)  feelsEl.textContent  = `ST ${Math.round(current.feels_like)}°`;

    // 3-day forecast
    if (forecastEl && weather.forecast && weather.forecast.length > 0) {
        const days = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
        forecastEl.innerHTML = weather.forecast.slice(0, 3).map(day => {
            const d       = new Date(day.date + 'T12:00:00');
            const dayName = days[d.getDay()];
            const emoji   = getWeatherEmoji(day.weather_code);
            return `
                <div class="forecast-day">
                    <span class="forecast-day-name">${dayName}</span>
                    <span class="forecast-day-emoji">${emoji}</span>
                    <span class="forecast-day-temps">
                        <strong>${Math.round(day.temp_max)}°</strong>
                        <span> / ${Math.round(day.temp_min)}°</span>
                    </span>
                </div>
            `;
        }).join('');
    }
}

function getWeatherEmoji(code) {
    if (!code && code !== 0) return '🌦️';
    if (code === 0) return '☀️';
    if (code === 1) return '🌤️';
    if (code === 2) return '⛅';
    if (code === 3) return '☁️';
    if (code === 45 || code === 48) return '🌫️';
    if (code >= 51 && code <= 57) return '🌧️';
    if (code >= 61 && code <= 67) return '🌧️';
    if (code >= 71 && code <= 77) return '❄️';
    if (code >= 80 && code <= 82) return '🌦️';
    if (code >= 85 && code <= 86) return '🌨️';
    if (code >= 95 && code <= 99) return '⛈️';
    return '🌦️';
}

/* ============================================================
   EXCHANGE RATES WIDGET  (/exchange-rates)
   ============================================================ */
async function loadExchangeRatesWidget() {
    try {
        const res    = await fetch('/exchange-rates', { credentials: 'include' });
        const result = await res.json();

        if (!result.success || !result.data) return;

        applyBcuRates(result.data);
    } catch (err) {
        console.error('Error loading exchange rates:', err);
    }
}

function applyBcuRates(rates) {
    // Build exchange rate lookup (values in UYU per foreign unit)
    if (rates.USD?.billete)   exchangeRates.USD = rates.USD.billete;
    if (rates.EUR?.value)     exchangeRates.EUR = rates.EUR.value;
    if (rates.ARS?.value)     exchangeRates.ARS = rates.ARS.value;
    if (rates.BRL?.value)     exchangeRates.BRL = rates.BRL.value;
    if (rates.GBP?.value)     exchangeRates.GBP = rates.GBP.value;
    if (rates.CHF?.value)     exchangeRates.CHF = rates.CHF.value;
    if (rates.UI?.value)      exchangeRates.UI  = rates.UI.value;
    if (rates.UR?.value)      exchangeRates.UR  = rates.UR.value;

    renderCotizWidget(rates);
    performConversion();

    // Update timestamp in converter modal
    if (rates.lastUpdate) {
        const el = document.getElementById('ratesUpdateTime');
        if (el) {
            const d = new Date(rates.lastUpdate);
            el.textContent = d.toLocaleString('es-UY', {
                day: '2-digit', month: '2-digit',
                hour: '2-digit', minute: '2-digit'
            });
        }
    }
}

function renderCotizWidget(rates) {
    const grid = document.getElementById('cotizGrid');
    if (!grid) return;

    const items = [
        { code: 'USD', label: 'Dólar', data: rates.USD, buy: rates.USD?.compra, sell: rates.USD?.billete },
        { code: 'EUR', label: 'Euro',  data: rates.EUR, buy: null, sell: rates.EUR?.value },
        { code: 'ARS', label: 'Peso Arg.', data: rates.ARS, buy: null, sell: rates.ARS?.value },
        { code: 'BRL', label: 'Real',  data: rates.BRL, buy: null, sell: rates.BRL?.value },
    ];

    const fmt = (v) => v != null ? parseFloat(v).toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--';

    grid.innerHTML = items.map(item => `
        <div class="cotiz-item">
            <span class="cotiz-item-code">${item.code}</span>
            ${item.buy != null ? `<span class="cotiz-item-buy">Compra <strong>$${fmt(item.buy)}</strong></span>` : ''}
            <span class="cotiz-item-sell">${item.buy != null ? 'Venta' : 'Ref.'} <strong>$${fmt(item.sell)}</strong></span>
        </div>
    `).join('');
}

/* ============================================================
   BITCOIN  (/dashboard/data, auto-updates every 15s)
   ============================================================ */
function renderBitcoin(bitcoin) {
    const priceEl  = document.getElementById('btcPrice');
    const changeEl = document.getElementById('btcChange');

    if (priceEl && bitcoin.price) {
        const fmt = bitcoin.price.toLocaleString('es-UY', { maximumFractionDigits: 0 });
        priceEl.textContent = `$${fmt}`;

        // Update exchange rate for converter (BTC in UYU)
        if (exchangeRates.USD) {
            exchangeRates.BTC = bitcoin.price * exchangeRates.USD;
        }
    }

    if (changeEl && bitcoin.change24h != null) {
        const ch     = bitcoin.change24h;
        const sign   = ch >= 0 ? '+' : '';
        const cls    = ch >= 0 ? 'positive' : 'negative';
        changeEl.textContent  = `${sign}${ch.toFixed(2)}%`;
        changeEl.className    = `btc-change ${cls}`;
    }
}

function startBtcAutoUpdate() {
    if (btcUpdateInterval) clearInterval(btcUpdateInterval);

    btcUpdateInterval = setInterval(async () => {
        try {
            const res    = await fetch('/dashboard/data', { credentials: 'include' });
            const result = await res.json();
            if (result.success && result.data?.bitcoinData) {
                renderBitcoin(result.data.bitcoinData);
            }
        } catch (_) { /* silent */ }
    }, 15000);
}

/* ============================================================
   NEWS WIDGET  (/news?country=UY&showAll=false)
   ============================================================ */
async function loadNewsWidget() {
    const list = document.getElementById('newsList');
    if (!list) return;

    try {
        const res    = await fetch('/news?country=UY&showAll=false', { credentials: 'include' });
        const events = await res.json();

        if (!events || !Array.isArray(events) || events.length === 0) {
            list.innerHTML = '<li class="news-loading">No hay noticias disponibles.</li>';
            return;
        }

        list.innerHTML = events.slice(0, 4).map(ev => {
            const timeAgo = getTimeAgo(new Date(ev.publishedAt || ev.createdAt));
            const title   = ev.title || ev.headline || 'Sin título';
            const src     = ev.source || '';
            return `
                <li>
                    <a class="news-item" href="${ev.url || ev.link || '#'}" target="_blank" rel="noopener noreferrer">
                        <span class="news-item-dot"></span>
                        <div class="news-item-text">
                            <p class="news-item-title">${escapeHtml(title)}</p>
                            <span class="news-item-meta">${src ? escapeHtml(src) + ' · ' : ''}${timeAgo}</span>
                        </div>
                    </a>
                </li>
            `;
        }).join('');
    } catch (err) {
        console.error('Error loading news:', err);
        list.innerHTML = '<li class="news-loading">No se pudieron cargar las noticias.</li>';
    }
}

/* ============================================================
   FORUM WIDGET
   ============================================================ */
function renderForumWidget(threads) {
    const list = document.getElementById('forumList');
    if (!list) return;

    if (!threads || threads.length === 0) {
        list.innerHTML = '<li class="forum-loading">No hay discusiones recientes.</li>';
        return;
    }

    list.innerHTML = threads.slice(0, 3).map(t => {
        const timeAgo = getTimeAgo(new Date(t.createdAt));
        const tags    = (t.hashtags || []).slice(0, 2).map(h =>
            `<span class="forum-tag">#${escapeHtml(h)}</span>`
        ).join('');
        return `
            <li>
                <a class="forum-item" href="/forum-thread/${t.id || t._id}">
                    <p class="forum-item-title">${escapeHtml(t.title)}</p>
                    <div class="forum-item-meta">
                        ${tags}
                        <span>❤️ ${t.likesCount || 0}</span>
                        <span>💬 ${t.commentsCount || 0}</span>
                        <span>${timeAgo}</span>
                    </div>
                </a>
            </li>
        `;
    }).join('');
}

/* ============================================================
   CENTINEL WIDGET
   ============================================================ */
function renderCentinelWidget(incidents) {
    const list = document.getElementById('centinelList');
    if (!list) return;

    if (!incidents || incidents.length === 0) {
        list.innerHTML = '<li class="centinel-loading">No hay alertas recientes.</li>';
        return;
    }

    const typeLabels = {
        homicidio: 'Homicidio',
        'rapiña': 'Rapiña',
        hurto: 'Hurto',
        copamiento: 'Copamiento',
        violencia_domestica: 'Violencia Doméstica',
        narcotrafico: 'Narcotráfico',
        otro: 'Otro'
    };

    list.innerHTML = incidents.slice(0, 3).map(inc => {
        const timeAgo = getTimeAgo(new Date(inc.createdAt));
        const sev     = inc.severity || 1;
        const type    = typeLabels[inc.type] || inc.type || 'Incidente';
        return `
            <li class="centinel-item sev-${sev}" onclick="window.location.href='/centinel'">
                <div class="centinel-item-info">
                    <p class="centinel-item-title">${escapeHtml(type)}</p>
                    <div class="centinel-item-meta">
                        <span class="sev-badge sev-${sev}">Nivel ${sev}</span>
                        ${inc.neighborhood ? `<span>📍 ${escapeHtml(inc.neighborhood)}</span>` : ''}
                        <span>${timeAgo}</span>
                    </div>
                </div>
            </li>
        `;
    }).join('');
}

/* ============================================================
   PROFILE WIDGET
   ============================================================ */
function renderProfileWidget(user) {
    const body = document.getElementById('profileWidgetBody');
    if (!body || !user) return;

    body.innerHTML = `
        <div class="profile-stat-grid">
            <div class="profile-stat">
                <span class="profile-stat-label">Reputación</span>
                <span class="profile-stat-value">${user.reputacion != null ? user.reputacion : '--'}</span>
            </div>
            <div class="profile-stat">
                <span class="profile-stat-label">Rol</span>
                <span class="profile-stat-value" style="font-size:0.9rem">${capitalizeFirst(user.role || 'user')}</span>
            </div>
        </div>
        <span class="profile-role-badge">${capitalizeFirst(user.role || 'usuario')}</span>
        <a href="/perfil" class="profile-action-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            Ver perfil completo
        </a>
    `;
}

/* ============================================================
   AI QUICK MESSAGE
   ============================================================ */
async function sendQuickAIMessage() {
    const input  = document.getElementById('aiQuickInput');
    const btn    = document.getElementById('aiSendBtn');
    const lastEl = document.getElementById('aiLastMsg');
    if (!input || !input.value.trim()) return;

    const msg = input.value.trim();
    input.value = '';
    if (btn) btn.disabled = true;

    if (lastEl) {
        lastEl.innerHTML = `<p class="ai-last-text">Pregunta: ${escapeHtml(msg)}</p>`;
    }

    try {
        const res  = await fetch('/assistant/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ message: msg })
        });
        const data = await res.json();

        if (lastEl) {
            const reply = data.reply || data.message || data.response || 'Sin respuesta.';
            const short = reply.length > 180 ? reply.slice(0, 180) + '…' : reply;
            lastEl.innerHTML = `
                <p class="ai-last-text ai-response">${escapeHtml(short)}</p>
            `;
        }
    } catch (_) {
        if (lastEl) {
            lastEl.innerHTML = `<p class="ai-last-text" style="color:var(--negative)">Error al conectar con el asistente.</p>`;
        }
    } finally {
        if (btn) btn.disabled = false;
    }
}

/* ============================================================
   NOTIFICATIONS MODAL
   ============================================================ */
function openNotificationsModal() {
    const modal = document.getElementById('notificationsModal');
    if (!modal) return;
    modal.classList.add('active');
    renderNotifications(dashboardData?.notifications || []);
}

function closeNotificationsModal() {
    const modal = document.getElementById('notificationsModal');
    if (modal) modal.classList.remove('active');
}

function renderNotifications(notifications) {
    const container = document.getElementById('notificationsList');
    if (!container) return;

    if (!notifications.length) {
        container.innerHTML = '<div class="empty-state">No tenés notificaciones pendientes.</div>';
        return;
    }

    container.innerHTML = notifications.map(n => {
        const timeAgo    = getTimeAgo(new Date(n.createdAt));
        const unreadCls  = !n.read ? 'unread' : '';
        return `
            <div class="notification-item ${unreadCls}" onclick="markNotificationAsRead('${n._id}')">
                <h4>${escapeHtml(n.title)}</h4>
                <p>${escapeHtml(n.message)}</p>
                <div class="notification-time">${timeAgo}</div>
            </div>
        `;
    }).join('');
}

async function markNotificationAsRead(id) {
    try {
        await fetch(`/dashboard/notifications/${id}/read`, {
            method: 'PATCH',
            credentials: 'include'
        });
        await loadDashboard();
        renderNotifications(dashboardData?.notifications || []);
    } catch (err) {
        console.error('Error marking notification:', err);
    }
}

async function markAllAsRead() {
    try {
        await fetch('/dashboard/notifications/read-all', {
            method: 'POST',
            credentials: 'include'
        });
        await loadDashboard();
        closeNotificationsModal();
    } catch (err) {
        console.error('Error marking all as read:', err);
    }
}

/* ============================================================
   CURRENCY CONVERTER MODAL
   ============================================================ */
function openCurrencyModal() {
    const modal = document.getElementById('currencyModal');
    if (modal) modal.classList.add('active');
    performConversion();
}

function closeCurrencyModal() {
    const modal = document.getElementById('currencyModal');
    if (modal) modal.classList.remove('active');
}

function swapCurrencies() {
    const fromSel = document.getElementById('fromCurrency');
    const toSel   = document.getElementById('toCurrency');
    if (!fromSel || !toSel) return;
    [fromSel.value, toSel.value] = [toSel.value, fromSel.value];
    performConversion();
}

function performConversion() {
    const amount   = parseFloat(document.getElementById('fromAmount')?.value) || 0;
    const fromCode = document.getElementById('fromCurrency')?.value;
    const toCode   = document.getElementById('toCurrency')?.value;
    const resultEl = document.getElementById('conversionResult');
    const rateEl   = document.getElementById('conversionRate');

    if (!fromCode || !toCode || !resultEl) return;

    // Convert both to UYU as base, then to target
    const toUYU = (code, val) => {
        if (code === 'UYU') return val;
        const r = exchangeRates[code];
        return r ? val * r : null;
    };

    const fromUYU = (code, val) => {
        if (code === 'UYU') return val;
        const r = exchangeRates[code];
        return r ? val / r : null;
    };

    const amountInUYU = toUYU(fromCode, amount);

    if (amountInUYU == null) {
        resultEl.textContent = '--';
        if (rateEl) rateEl.textContent = 'Cotización no disponible';
        return;
    }

    const converted = fromUYU(toCode, amountInUYU);

    if (converted == null) {
        resultEl.textContent = '--';
        if (rateEl) rateEl.textContent = 'Cotización no disponible';
        return;
    }

    const fmtConverted = converted.toLocaleString('es-UY', {
        minimumFractionDigits: 2,
        maximumFractionDigits: fromCode === 'BTC' || toCode === 'BTC' ? 8 : 2
    });

    resultEl.textContent = `${fmtConverted} ${toCode}`;

    if (rateEl) {
        // Show the rate for 1 unit from → to
        const oneUYU    = toUYU(fromCode, 1);
        const oneTarget = oneUYU != null ? fromUYU(toCode, oneUYU) : null;
        if (oneTarget != null) {
            const fmtRate = oneTarget.toLocaleString('es-UY', {
                minimumFractionDigits: 2,
                maximumFractionDigits: toCode === 'BTC' ? 8 : 4
            });
            rateEl.textContent = `1 ${fromCode} = ${fmtRate} ${toCode}`;
        } else {
            rateEl.textContent = '';
        }
    }
}

/* ============================================================
   HELPERS
   ============================================================ */
function getTimeAgo(date) {
    if (!date || isNaN(date)) return '';
    const secs = Math.floor((Date.now() - date) / 1000);

    if (secs < 60)        return 'Hace un momento';
    if (secs < 3600)      return `Hace ${Math.floor(secs / 60)} min`;
    if (secs < 86400)     return `Hace ${Math.floor(secs / 3600)} h`;
    if (secs < 2592000)   return `Hace ${Math.floor(secs / 86400)} días`;
    if (secs < 31536000)  return `Hace ${Math.floor(secs / 2592000)} meses`;
    return `Hace ${Math.floor(secs / 31536000)} años`;
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function capitalizeFirst(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
}
