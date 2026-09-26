/**
 * MeetIn KYC Server
 * Receives document from Android app, uploads to Upstash Blob,
 * calls ID Analyzer, saves result to Firebase Realtime Database
 */

const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const FormData = require('form-data');
const bodyParser = require('body-parser');

// ============================================================
// CONFIGURATION
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
// INITIALIZE FIREBASE ADMIN
// ============================================================
let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf-8');
        serviceAccount = JSON.parse(decoded);
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
// UPSTASH BLOB UPLOAD
// ============================================================
async function uploadToUpstash(deviceId, timestamp, base64Data) {
    const fileName = `${deviceId}_${timestamp}.jpg`;

    try {
        const response = await axios.post(
            `${UPSTASH_REDIS_REST_URL}/set/${UPSTASH_BLOB_BUCKET}/${fileName}`,
            Buffer.from(base64Data, 'base64'),
            {
                headers: {
                    'Authorization': `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
                    'Content-Type': 'image/jpeg',
                    'Upstash-Blob-Content-Type': 'image/jpeg'
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                timeout: 30000
            }
        );

        let publicUrl = '';
        if (response.data && response.data.result) {
            publicUrl = response.data.result;
        }
        if (!publicUrl) {
            publicUrl = `${UPSTASH_REDIS_REST_URL}/get/${UPSTASH_BLOB_BUCKET}/${fileName}`;
        }

        console.log(`📤 Uploaded to Upstash: ${fileName}`);
        return {
            url: publicUrl,
            key: `${UPSTASH_BLOB_BUCKET}/${fileName}`,
            success: true
        };

    } catch (error) {
        console.error('⚠️ Upstash upload failed:', error.message);
        return {
            url: '',
            key: '',
            success: false,
            error: error.message
        };
    }
}

// ============================================================
// EXPRESS APP
// ============================================================
const app = express();
app.use(bodyParser.json({ limit: '25mb' }));
app.use(bodyParser.urlencoded({ limit: '25mb', extended: true }));

app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'MeetIn KYC Server',
        storage: 'upstash-blob',
        timestamp: Date.now()
    });
});

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

        const timestamp = Date.now();
        const uploadResult = await uploadToUpstash(deviceId, timestamp, documentBase64);

        const form = new FormData();
        form.append('document', Buffer.from(documentBase64, 'base64'), {
            filename: 'document.jpg',
            contentType: 'image/jpeg'
        });

        if (documentType) form.append('document_type', documentType);
        form.append('verify_expiry', 'true');
        form.append('verify_document_number', 'true');

        console.log(`🔍 Calling ID Analyzer...`);

        const idAnalyzerResponse = await axios.post(ID_ANALYZER_ENDPOINT, form, {
            headers: {
                ...form.getHeaders(),
                'X-API-KEY': ID_ANALYZER_API_KEY
            },
            timeout: 30000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        const result = idAnalyzerResponse.data;
        const decision = result.decision || 'reject';
        const approved = decision === 'accept';

        let name = '';
        let documentNumber = '';
        let expiry = '';

        if (result.result) {
            const r = result.result;
            if (r.firstName || r.lastName) {
                name = [r.firstName, r.lastName].filter(Boolean).join(' ').trim();
            } else if (r.fullName) {
                name = r.fullName;
            }
            documentNumber = r.documentNumber || '';
            expiry = r.expiryDate || r.documentExpiry || '';
        }

        const kycData = {
            kyc_status: approved ? 'approved' : 'rejected',
            kyc_document_type: documentType || 'auto',
            kyc_name: name,
            kyc_document_number: documentNumber,
            kyc_expiry: expiry,
            kyc_document_url: uploadResult.url,
            kyc_document_key: uploadResult.key,
            kyc_storage_provider: 'upstash',
            kyc_decision: decision,
            kyc_submitted_at: timestamp,
            kyc_verified_at: Date.now(),
            kyc_rejected_reason: approved ? '' : (result.error?.message || 'Document verification failed')
        };

        await db.ref(`devices/${deviceId}/kyc`).set(kycData);
        await db.ref(`devices/${deviceId}/kyc_history/${timestamp}`).set({
            ...kycData,
            raw_response: JSON.stringify(result).substring(0, 5000)
        });

        console.log(`✅ KYC saved for ${deviceId}: ${decision}`);

        const processingTime = Date.now() - startTime;
        res.json({
            approved,
            decision,
            name: name || 'Unknown',
            documentNumber,
            expiry,
            documentUrl: uploadResult.url,
            message: approved ? 'Document verified successfully' : (result.error?.message || 'Document could not be verified'),
            processingTime
        });

    } catch (error) {
        console.error('❌ Scan error:', error.message);
        let errorMessage = 'Verification failed. Please try again.';
        if (error.response) {
            errorMessage = error.response.data?.error?.message || errorMessage;
        }
        res.status(500).json({
            approved: false,
            message: errorMessage,
            error: error.message
        });
    }
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 MeetIn KYC Server running on port ${PORT}`);
    console.log(`📊 Firebase DB: ${FIREBASE_DB_URL}`);
    console.log(`📦 Storage: Upstash Blob`);
});
