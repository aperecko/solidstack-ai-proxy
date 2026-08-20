import { getDelegatedAccessToken } from './auth/service-account.js';
import { fetchAvailableModels } from './cloudcode/model-api.js';

async function test() {
    try {
        console.log('Testing DWD token generation...');
        const token = await getDelegatedAccessToken('10@adamassist.com');
        console.log('Got token, fetching models...');
        const result = await fetchAvailableModels(token.accessToken);
        console.log('Success! Models:', Object.keys(result));
    } catch (e) {
        console.error('Failed:', e);
    }
}
test();
