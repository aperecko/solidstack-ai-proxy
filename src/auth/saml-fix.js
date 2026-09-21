// Temporary script to test Entra logout
import https from 'https';

const url = 'https://login.microsoftonline.com/3a8f2256-4edc-496f-8dd2-0e1cdfb93252/saml2?SAMLRequest=dummy';
https.get(url, (res) => {
    console.log('Status Code:', res.statusCode);
}).on('error', (e) => {
    console.error('Error:', e);
});
