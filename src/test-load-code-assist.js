import { getDelegatedAccessToken } from './auth/service-account.js';
import { getSubscriptionTier } from './cloudcode/model-api.js';

async function test() {
    try {
        console.log('Testing loadCodeAssist with DWD token...');
        const token = await getDelegatedAccessToken('10@adamassist.com');
        console.log('Got token, fetching tier...');
        const result = await getSubscriptionTier(token.accessToken);
        console.log('Success!', result);
    } catch (e) {
        console.error('Failed:', e);
    }
}
test();
