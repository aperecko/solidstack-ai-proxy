import { getDelegatedAccessToken } from './auth/service-account.js';
import { fetchAvailableModels } from './cloudcode/model-api.js';
import { onboardUser, getDefaultTierId } from './account-manager/onboarding.js';

async function test() {
    try {
        console.log('Testing DWD token generation...');
        const token = await getDelegatedAccessToken('10@adamassist.com');
        console.log('Got token, running onboardUser...');
        const projectId = await onboardUser(token.accessToken, getDefaultTierId('free'));
        console.log('Onboarded project:', projectId);
        
        console.log('Now fetching models...');
        const result = await fetchAvailableModels(token.accessToken, projectId);
        console.log('Success! Models:', Object.keys(result));
    } catch (e) {
        console.error('Failed:', e);
    }
}
test();
