const { execSync } = require('child_process');
const fs = require('fs-extra');

if (fs.existsSync("./node-red-mcu")) {
    execSync("git pull");
} else {
    execSync("git clone https://github.com/phoddie/node-red-mcu.git node-red-mcu");
}

return;