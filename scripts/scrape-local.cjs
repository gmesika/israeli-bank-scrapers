#!/usr/bin/env node
/**
 * Run a scraper locally using credentials from secrets/<companyId>.
 *
 * File format: one credential field per line, in SCRAPERS[companyId].loginFields order.
 *
 * Examples:
 *   npm run scrape:local -- mizrahi
 *   npm run scrape:local -- mizrahi --months 12 --verbose
 *   npm run scrape:local -- mizrahi --show-browser
 */
const path = require('path');
const { CompanyTypes, SCRAPERS, createScraper } = require('../lib/index');
const { buildCredentials } = require('./read-local-credentials.cjs');

const OPT_IN_FEATURES = {
  mizrahi: ['mizrahi:pendingIfHasGenericDescription', 'mizrahi:pendingIfTodayTransaction'],
};

function parseArgs(argv) {
  const positional = [];
  const flags = {
    months: 12,
    showBrowser: false,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--months') {
      flags.months = Number(argv[++i]);
      continue;
    }
    if (arg === '--show-browser') {
      flags.showBrowser = true;
      continue;
    }
    if (arg === '--verbose') {
      flags.verbose = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    positional.push(arg);
  }

  const companyId = positional[0];
  if (!companyId) {
    throw new Error('Usage: npm run scrape:local -- <companyId> [--months 12] [--show-browser] [--verbose]');
  }

  if (!SCRAPERS[companyId]) {
    throw new Error(`Unknown company "${companyId}". Check CompanyTypes / SCRAPERS in src/definitions.ts`);
  }

  if (!CompanyTypes[companyId]) {
    throw new Error(`Company "${companyId}" is not registered in CompanyTypes`);
  }

  return { companyId, flags };
}

function getStartDate(months) {
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);
  return startDate;
}

function summarizeResult(result) {
  if (!result.success) {
    console.error('SCRAPE_FAILED', result.errorType ?? 'UNKNOWN', result.errorMessage ?? '');
    process.exit(1);
  }

  let totalTxns = 0;
  for (const account of result.accounts ?? []) {
    totalTxns += account.txns.length;
    console.log(
      `Account ${account.accountNumber}: ${account.txns.length} transactions, balance=${account.balance ?? 'n/a'}`,
    );

    for (const txn of account.txns.slice(0, 3)) {
      console.log(`  ${txn.date.slice(0, 10)} | ${txn.chargedAmount} | ${txn.description} | ${txn.status}`);
    }
    if (account.txns.length > 3) {
      console.log(`  ... and ${account.txns.length - 3} more`);
    }
  }

  console.log(`SUCCESS accounts=${result.accounts?.length ?? 0} total_txns=${totalTxns}`);
  process.exit(0);
}

async function main() {
  const { companyId, flags } = parseArgs(process.argv.slice(2));
  const scraperMeta = SCRAPERS[companyId];
  const credentials = buildCredentials(companyId, scraperMeta.loginFields);

  const scraper = createScraper({
    companyId: CompanyTypes[companyId],
    startDate: getStartDate(flags.months),
    showBrowser: flags.showBrowser,
    verbose: flags.verbose,
    defaultTimeout: 90000,
    navigationRetryCount: 2,
    optInFeatures: OPT_IN_FEATURES[companyId],
  });

  console.log(`Scraping ${scraperMeta.name} (last ${flags.months} months)...`);
  const result = await scraper.scrape(credentials);
  summarizeResult(result);
}

main().catch(error => {
  console.error('UNCAUGHT', error.message);
  process.exit(1);
});
