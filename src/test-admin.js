import { GoogleAuth } from 'google-auth-library';
import { admin } from '@googleapis/admin';
import { SERVICE_ACCOUNT_KEY_PATH } from './auth/service-account.js';

async function testAdmin() {
    try {
        const adminEmail = 'adam@adamassist.com';
        console.log(`Authenticating as ${adminEmail}...`);
        
        const auth = new GoogleAuth({
            keyFile: SERVICE_ACCOUNT_KEY_PATH,
            scopes: ['https://www.googleapis.com/auth/admin.directory.user'],
            clientOptions: {
                subject: adminEmail
            }
        });
        
        const client = await auth.getClient();
        
        const directory = admin({
            version: 'directory_v1',
            auth: client
        });
        
        console.log('Fetching user 10@adamassist.com...');
        const user = await directory.users.get({
            userKey: '10@adamassist.com'
        });
        
        console.log('Success!', user.data.primaryEmail);
    } catch (e) {
        console.error('Failed:', e.message);
    }
}
testAdmin();
