const fs = require("fs");
const p = "src/App.tsx";
let s = fs.readFileSync(p, "utf8");
const lines = s.split(/\r?\n/);

const hasAppt = /\bappointments\b/.test(s);
const callExpr = hasAppt ? "() => exportToCSV(appointments)" : "() => exportToCSV()";

let wiredCount = 0;
for (let i = 0; i < lines.length; i++) {
  if (/CSV/i.test(lines[i])) {
    // Tim dong '<button' gan nhat phia tren dong co chu CSV (trong vong 8 dong)
    for (let j = i; j >= Math.max(0, i - 8); j--) {
      if (/<button\b/.test(lines[j])) {
        // Gan onClick cho khoi <button ...> tu dong j den dong co '>'
        let k = j;
        while (k < lines.length && !lines[k].includes(">")) k++;
        const block = lines.slice(j, k + 1).join("\n");
        let updatedBlock;
        if (/onClick=/.test(block)) {
          updatedBlock = block.replace(/onClick=\{[^}]*\}/, `onClick={${callExpr}}`);
        } else {
          updatedBlock = block.replace(/<button\b/, `<button onClick={${callExpr}}`);
        }
        const newLines = updatedBlock.split("\n");
        lines.splice(j, k - j + 1, ...newLines);
        i = j + newLines.length - 1;
        wiredCount++;
        break;
      }
    }
  }
}

fs.writeFileSync(p, lines.join("\n"), "utf8");
console.log("Wired CSV buttons count:", wiredCount, "hasAppt:", hasAppt);