import { GoogleAuth } from 'google-auth-library';
import { SERVICE_ACCOUNT_KEY_PATH } from './auth/service-account.js';
import fetch from 'node-fetch';

async function enableApi() {
    try {
        const auth = new GoogleAuth({
            keyFile: SERVICE_ACCOUNT_KEY_PATH,
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        });
        const client = await auth.getClient();
        const token = await client.getAccessToken();

        console.log('Enabling API...');
        const response = await fetch('https://serviceusage.googleapis.com/v1/projects/935010979030/services/cloudcode-pa.googleapis.com:enable', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token.token}`,
                'Content-Type': 'application/json'
            }
        });
        const data = await response.json();
        console.log('Response:', data);
    } catch (e) {
        console.error('Failed:', e);
    }
}
enableApi();
