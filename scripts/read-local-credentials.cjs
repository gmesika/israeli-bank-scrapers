const fs = require('fs');
const path = require('path');

function readLocalCredentials(companyId, secretsDir = path.join(__dirname, '..', 'secrets')) {
  const secretsPath = path.join(secretsDir, companyId);
  if (!fs.existsSync(secretsPath)) {
    throw new Error(`Missing credentials file: secrets/${companyId}`);
  }

  const raw = fs.readFileSync(secretsPath, 'utf8').trim();
  if (!raw) {
    throw new Error(`secrets/${companyId} is empty — save the file before running`);
  }

  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
  if (lines.length === 0) {
    throw new Error(`secrets/${companyId} has no credential lines`);
  }

  return lines;
}

function buildCredentials(companyId, loginFields, secretsDir) {
  const lines = readLocalCredentials(companyId, secretsDir);

  if (lines.length < loginFields.length) {
    throw new Error(
      `secrets/${companyId} has ${lines.length} line(s) but ${companyId} requires ${loginFields.length}: ${loginFields.join(', ')}`,
    );
  }

  return Object.fromEntries(loginFields.map((field, index) => [field, lines[index]]));
}

module.exports = {
  buildCredentials,
  readLocalCredentials,
};
