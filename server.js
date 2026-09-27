/**
 * MeetIn KYC Server — Hybrid ID Analyzer
 * Tries multipart first, falls back to JSON base64
 */

const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const FormData = require('form-data');
const bodyParser = require('body-parser');

// ============================================================
// CONFIG
// ============================================================
const ID_ANALYZER_API_KEY = process.env.ID_ANALYZER_API_KEY;
const ID_ANALYZER_ENDPOINT = 'https://api2.idanalyzer.com/scan';
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || 'https://meetin-3e70e-default-rtdb.firebaseio.com';
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const UPSTASH_BLOB_BUCKET = process.env.UPSTASH_BLOB_BUCKET || 'meetin-kyc';

if (!ID_ANALYZER_API_KEY) {
    console.error('❌ ID_ANALYZER_API_KEY not set');
    process.exit(1);
}
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    console.error('❌ Upstash credentials not set');
    process.exit(1);
}

// ============================================================
// FIREBASE INIT
// ============================================================
let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
        try {
            const decoded = Buffer.from(raw, 'base64').toString('utf-8');
            serviceAccount = JSON.parse(decoded);
            console.log('✅ Parsed FIREBASE_SERVICE_ACCOUNT as base64');
        } catch (e1) {
            serviceAccount = JSON.parse(raw);
            console.log('✅ Parsed FIREBASE_SERVICE_ACCOUNT as JSON');
        }
    } else {
        serviceAccount = require('./firebase-service-account.json');
    }
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: FIREBASE_DB_URL
    });
    console.log('✅ Firebase Admin initialized');
} catch (error) {
    console.error('❌ Firebase init error:', error.message);
    process.exit(1);
}

const db = admin.database();

// ============================================================
// UPSTASH REDIS UPLOAD
// ============================================================
async function uploadToUpstash(deviceId, timestamp, base64Data) {
    const key = `${UPSTASH_BLOB_BUCKET}/${deviceId}_${timestamp}`;
    const url = `${UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`;

    try {
        const response = await axios.post(url, base64Data, {
            headers: {
                'Authorization': `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
                'Content-Type': 'text/plain'
            },
            timeout: 30000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        console.log(`📤 Upstash OK: ${key}`);
        return {
            url: `${UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`,
            key: key,
            success: true
        };
    } catch (error) {
        console.error('⚠️ Upstash error:', error.message);
        return { url: '', key: '', success: false, error: error.message };
    }
}

// ============================================================
// ID ANALYZER — HYBRID (Multipart first, JSON fallback)
// ============================================================
async function callIdAnalyzerMultipart(documentBase64, documentType) {
    const form = new FormData();
    form.append('document', Buffer.from(documentBase64, 'base64'), {
        filename: 'document.jpg',
        contentType: 'image/jpeg'
    });
    if (documentType) form.append('document_type', documentType);

    console.log('🔍 ID Analyzer [1/2]: Trying multipart form...');

    const response = await axios.post(ID_ANALYZER_ENDPOINT, form, {
        headers: {
            ...form.getHeaders(),
            'X-API-KEY': ID_ANALYZER_API_KEY
        },
        timeout: 60000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: (status) => status >= 200 && status < 500
    });

    console.log(`🔍 ID Analyzer [1/2] status: ${response.status}`);

    if (response.status >= 400) {
        const errBody = response.data;
        console.error('   Error:', JSON.stringify(errBody).substring(0, 300));
        throw new Error('MULTIPART_FAILED: ' + (errBody.error?.message || 'Unknown'));
    }

    return response.data;
}

async function callIdAnalyzerJson(documentBase64, documentType) {
    const payload = {
        document: documentBase64
    };
    if (documentType) payload.document_type = documentType;

    console.log('🔍 ID Analyzer [2/2]: Trying JSON base64...');

    const response = await axios.post(ID_ANALYZER_ENDPOINT, payload, {
        headers: {
            'X-API-KEY': ID_ANALYZER_API_KEY,
            'Content-Type': 'application/json'
        },
        timeout: 60000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: (status) => status >= 200 && status < 500
    });

    console.log(`🔍 ID Analyzer [2/2] status: ${response.status}`);

    if (response.status >= 400) {
        const errBody = response.data;
        console.error('   Error:', JSON.stringify(errBody).substring(0, 300));
        throw new Error('JSON_FAILED: ' + (errBody.error?.message || 'Unknown'));
    }

    return response.data;
}

async function callIdAnalyzerHybrid(documentBase64, documentType) {
    // Attempt 1: Multipart
    try {
        const result = await callIdAnalyzerMultipart(documentBase64, documentType);
        console.log('✅ ID Analyzer succeeded via MULTIPART');
        return { result, method: 'multipart' };
    } catch (e1) {
        console.warn(`⚠️ Multipart failed: ${e1.message}`);
    }

    // Attempt 2: JSON
    try {
        const result = await callIdAnalyzerJson(documentBase64, documentType);
        console.log('✅ ID Analyzer succeeded via JSON');
        return { result, method: 'json' };
    } catch (e2) {
        console.error(`❌ JSON failed too: ${e2.message}`);
        throw new Error('Both endpoints failed');
    }
}

// ============================================================
// EXPRESS
// ============================================================
const app = express();
app.use(bodyParser.json({ limit: '25mb' }));
app.use(bodyParser.urlencoded({ limit: '25mb', extended: true }));

app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'MeetIn KYC Server',
        storage: 'upstash-redis',
        id_analyzer: 'hybrid (multipart → json)',
        timestamp: Date.now()
    });
});

// ============================================================
// /scan
// ============================================================
app.post('/scan', async (req, res) => {
    const startTime = Date.now();

    try {
        const { deviceId, documentBase64, documentType } = req.body;

        if (!deviceId || !documentBase64) {
            return res.status(400).json({
                approved: false,
                message: 'Missing deviceId or documentBase64'
            });
        }

        console.log(`📥 Scan request from device: ${deviceId}`);
        console.log(`   Document size: ${documentBase64.length} chars`);

        // --- 1. Upstash (non-fatal) ---
        const timestamp = Date.now();
        let uploadResult = { url: '', key: '', success: false };
        try {
            uploadResult = await uploadToUpstash(deviceId, timestamp, documentBase64);
        } catch (e) {
            console.warn('⚠️ Upstash threw:', e.message);
        }

        // --- 2. ID Analyzer (hybrid) ---
        let analyzerResult;
        let method = 'unknown';
        try {
            const hybridResult = await callIdAnalyzerHybrid(documentBase64, documentType);
            analyzerResult = hybridResult.result;
            method = hybridResult.method;
        } catch (apiError) {
            console.error('❌ ID Analyzer total failure:', apiError.message);

            const kycData = {
                kyc_status: 'rejected',
                kyc_decision: 'error',
                kyc_submitted_at: timestamp,
                kyc_verified_at: Date.now(),
                kyc_rejected_reason: 'ID Analyzer unavailable: ' + apiError.message
            };
            await db.ref(`devices/${deviceId}/kyc`).set(kycData);
            return res.json({
                approved: false,
                decision: 'error',
                message: 'Verification service unavailable. Try again.'
            });
        }

        // --- 3. Parse ---
        const decision = analyzerResult.decision || 'reject';
        const approved = decision === 'accept';

        let name = '';
        let documentNumber = '';
        let expiry = '';

        if (analyzerResult.result) {
            const r = analyzerResult.result;
            if (r.firstName || r.lastName) {
                name = [r.firstName, r.lastName].filter(Boolean).join(' ').trim();
            } else if (r.fullName) {
                name = r.fullName;
            }
            documentNumber = r.documentNumber || '';
            expiry = r.expiryDate || r.documentExpiry || '';
        }

        // --- 4. Save to Firebase ---
        const kycData = {
            kyc_status: approved ? 'approved' : 'rejected',
            kyc_document_type: documentType || 'auto',
            kyc_name: name,
            kyc_document_number: documentNumber,
            kyc_expiry: expiry,
            kyc_document_url: uploadResult.url || '',
            kyc_document_key: uploadResult.key || '',
            kyc_storage_provider: 'upstash',
            kyc_decision: decision,
            kyc_api_method: method,
            kyc_submitted_at: timestamp,
            kyc_verified_at: Date.now(),
            kyc_rejected_reason: approved ? '' : (analyzerResult.error?.message || 'Document could not be verified')
        };

        await db.ref(`devices/${deviceId}/kyc`).set(kycData);
        await db.ref(`devices/${deviceId}/kyc_history/${timestamp}`).set({
            ...kycData,
            raw_response: JSON.stringify(analyzerResult).substring(0, 5000)
        });

        console.log(`✅ KYC saved for ${deviceId}: ${decision} (via ${method})`);

        res.json({
            approved,
            decision,
            name: name || 'Unknown',
            documentNumber,
            expiry,
            documentUrl: uploadResult.url || '',
            method,
            message: approved ? 'Document verified successfully' : (analyzerResult.error?.message || 'Document could not be verified'),
            processingTime: Date.now() - startTime
        });

    } catch (error) {
        console.error('❌ Scan error:', error.message);
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', JSON.stringify(error.response.data).substring(0, 500));
        }
        res.status(500).json({
            approved: false,
            decision: 'error',
            message: 'Verification failed. Please try again.',
            error: error.message
        });
    }
});

// ============================================================
// /pending
// ============================================================
app.get('/pending', async (req, res) => {
    try {
        const snapshot = await db.ref('devices').once('value');
        const devices = snapshot.val() || {};
        const pending = [], rejected = [], approved = [];
        for (const [deviceId, device] of Object.entries(devices)) {
            if (device.kyc) {
                const entry = { deviceId, ...device.kyc };
                if (device.kyc.kyc_status === 'pending') pending.push(entry);
                else if (device.kyc.kyc_status === 'rejected') rejected.push(entry);
                else if (device.kyc.kyc_status === 'approved') approved.push(entry);
            }
        }
        res.json({ pending, rejected, approved, total: pending.length + rejected.length + approved.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// /approve
// ============================================================
app.post('/approve', async (req, res) => {
    try {
        const { deviceId, approve, reason } = req.body;
        if (!deviceId) return res.status(400).json({ error: 'Missing deviceId' });
        await db.ref(`devices/${deviceId}/kyc`).update({
            kyc_status: approve ? 'approved' : 'rejected',
            kyc_manual_override: true,
            kyc_manual_at: Date.now(),
            kyc_rejected_reason: approve ? '' : (reason || 'Rejected by admin')
        });
        res.json({ success: true, deviceId, status: approve ? 'approved' : 'rejected' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 MeetIn KYC Server running on port ${PORT}`);
    console.log(`📊 Firebase DB: ${FIREBASE_DB_URL}`);
    console.log(`📦 Storage: Upstash Redis`);
    console.log(`🔑 ID Analyzer: HYBRID (multipart → json)`);
});
