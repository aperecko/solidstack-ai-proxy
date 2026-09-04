const { calculateEconomics } = require('../src/economic-engine.js');

async function testEconomics() {
    console.log("Testing economic engine ROI calculations...");
    const result = calculateEconomics('gemini-1.5-pro', 1000000, 500000, 'adamperecko@gmail.com');
    if (result.realDollarRoiCad === undefined) {
        console.error("FAIL: realDollarRoiCad is missing");
        process.exit(1);
    }
    console.log("PASS: Economics engine includes ROI.");
    process.exit(0);
}

testEconomics();
