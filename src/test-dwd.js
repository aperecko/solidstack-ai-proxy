import { getDelegatedAccessToken } from './auth/service-account.js';
import { logger } from './utils/logger.js';

async function test() {
    try {
        console.log('Testing DWD token generation for 10@adamassist.com...');
        const token = await getDelegatedAccessToken('10@adamassist.com');
        console.log('Success! Token starts with:', token.accessToken.substring(0, 20) + '...');
    } catch (e) {
        console.error('Failed:', e);
    }
}
test();
