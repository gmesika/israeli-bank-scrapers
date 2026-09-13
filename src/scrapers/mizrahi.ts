import moment from 'moment';
import { type Frame, type HTTPRequest, type Page } from 'puppeteer';
import { SHEKEL_CURRENCY } from '../constants';
import {
  pageEvalAll,
  waitUntilElementDisappear,
  waitUntilElementFound,
  waitUntilIframeFound,
} from '../helpers/elements-interactions';
import { fetchPostWithinPage } from '../helpers/fetch';
import { waitForUrl } from '../helpers/navigation';
import { type Transaction, TransactionStatuses, TransactionTypes, type TransactionsAccount } from '../transactions';
import { BaseScraperWithBrowser, LoginResults, type PossibleLoginResults } from './base-scraper-with-browser';
import { ScraperErrorTypes } from './errors';
import { getDebug } from '../helpers/debug';
import { getRawTransaction } from '../helpers/transactions';
import { type ScraperOptions } from './interface';

const debug = getDebug('mizrahi');

interface ScrapedTransaction {
  RecTypeSpecified: boolean;
  MC02PeulaTaaEZ: string;
  MC02SchumEZ: number;
  MC02AsmahtaMekoritEZ: string;
  MC02TnuaTeurEZ: string;
  IsTodayTransaction: boolean;
  MC02ErehTaaEZ: string;
  MC02ShowDetailsEZ?: string;
  MC02KodGoremEZ: any;
  MC02SugTnuaKaspitEZ: any;
  MC02AgidEZ: any;
  MC02SeifMaralEZ: any;
  MC02NoseMaralEZ: any;
  TransactionNumber: any;
}

interface ScrapedTransactionsResult {
  header: {
    success: boolean;
    messages: { text: string }[];
  };
  body: {
    fields: {
      Yitra: string;
    };
    table: {
      rows: ScrapedTransaction[];
    };
  };
}

type MoreDetailsResponse = {
  body: {
    fields: [
      [
        {
          Records: [
            {
              Fields: Array<{
                Label: string;
                Value: string;
              }>;
            },
          ];
        },
      ],
    ];
  };
};

type MoreDetails = {
  entries: Record<string, string>;
  memo: string | undefined;
};

const BASE_WEBSITE_URL = 'https://www.mizrahi-tefahot.co.il';
const LOGIN_URL = `${BASE_WEBSITE_URL}/login/index.html#/auth-page-he`;
const BASE_APP_URL = 'https://mto.mizrahi-tefahot.co.il';
const AFTER_LOGIN_BASE_URL = /https:\/\/mto\.mizrahi-tefahot\.co\.il\/OnlineApp\/.*/;
const OSH_PAGE = '/osh/legacy/legacy-Osh-Main';
const TRANSACTIONS_PAGE = '/osh/legacy/root-main-osh-p428New';
const TRANSACTIONS_REQUEST_URLS = [
  `${BASE_APP_URL}/OnlinePilot/api/SkyOSH/get428Index`,
  `${BASE_APP_URL}/Online/api/SkyOSH/get428Index`,
];
const PENDING_TRANSACTIONS_PAGE = '/osh/legacy/legacy-Osh-p420';
const PENDING_TRANSACTIONS_IFRAME = 'p420.aspx';
const MORE_DETAILS_URL = `${BASE_APP_URL}/Online/api/OSH/getMaherBerurimSMF`;
const CHANGE_PASSWORD_URL = /https:\/\/www\.mizrahi-tefahot\.co\.il\/login\/index\.html#\/change-pass/;
const DATE_FORMAT = 'DD/MM/YYYY';
const MAX_ROWS_PER_REQUEST = 10000000000;

const usernameSelector = '#userNumberDesktopHeb';
const passwordSelector = '#passwordDesktopHeb';
const submitButtonSelector = 'button.btn.btn-primary';
const invalidPasswordSelector = 'a[href*="https://sc.mizrahi-tefahot.co.il/SCServices/SC/P010.aspx"]';
const afterLoginSelector = '#dropdownBasic';
const loginSpinnerSelector = 'div.ngx-overlay.loading-foreground';
const accountDropDownItemSelector = '#AccountPicker .item';
const pendingTrxIdentifierId = '#ctl00_ContentPlaceHolder2_panel1';
const checkingAccountTabHebrewName = 'עובר ושב';
const checkingAccountTabEnglishName = 'Checking Account';
const genericDescriptions = ['העברת יומן לבנק זר מסניף זר'];

function sanitizeUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const aggregate = err as Error & { errors?: unknown[] };
    if (Array.isArray(aggregate.errors) && aggregate.errors.length > 0) {
      return `${err.name}: ${err.message} [${aggregate.errors.map(describeError).join(' | ')}]`;
    }
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}

function isMizrahiApiUrl(url: string): boolean {
  return /SkyOSH|get428|Online\/api|OnlinePilot\/api|getMaherBerurim|osh\/legacy|p428|p420/i.test(url);
}

function matchLookedForUrl(url: string, candidates: string[]): 'exact' | 'prefix' | null {
  const pathOnly = url.split('?')[0];
  if (candidates.includes(url) || candidates.includes(pathOnly)) {
    return 'exact';
  }
  if (candidates.some(candidate => pathOnly.startsWith(candidate) || url.startsWith(candidate))) {
    return 'prefix';
  }
  return null;
}

async function collectHrefsContaining(page: Page, needle: string): Promise<string[]> {
  return page.$$eval(
    'a[href]',
    (anchors, part: string) =>
      anchors.map(anchor => anchor.getAttribute('href') || '').filter(href => href.includes(part)),
    needle,
  );
}

async function collectOshLikeHrefs(page: Page): Promise<string[]> {
  return page.$$eval('a[href]', anchors =>
    anchors.map(anchor => anchor.getAttribute('href') || '').filter(href => /osh|428|420|SkyOSH/i.test(href)),
  );
}

function startRequestSniffer(page: Page, lookedForUrls: string[]) {
  const seen: string[] = [];
  const matchedRequests: HTTPRequest[] = [];
  const handler = (request: HTTPRequest) => {
    const url = request.url();
    if (!isMizrahiApiUrl(url)) {
      return;
    }
    const sanitized = sanitizeUrlForLog(url);
    const match = matchLookedForUrl(url, lookedForUrls);
    const line = `${request.method()} ${sanitized}${match ? ` [${match}-match]` : ''}`;
    seen.push(line);
    if (match === 'exact') {
      matchedRequests.push(request);
    }
    debug('network %s', line);
  };
  page.on('request', handler);
  return {
    seen,
    matchedRequests,
    stop() {
      page.off('request', handler);
    },
  };
}

async function clickHrefContaining(page: Page, hrefPart: string, purpose: string): Promise<string[]> {
  const selector = `a[href*="${hrefPart}"]`;
  debug('looking for %s selector=%s url=%s', purpose, selector, sanitizeUrlForLog(page.url()));
  try {
    await waitUntilElementFound(page, selector);
  } catch (err) {
    const similar = await collectOshLikeHrefs(page).catch(() => []);
    debug('NOT FOUND %s selector=%s similarHrefs=%o error=%s', purpose, selector, similar, describeError(err));
    throw new Error(
      `Mizrahi: looking for ${purpose} (${selector}) — not found. similar hrefs: ${similar.join(', ') || 'none'}. ${describeError(err)}`,
    );
  }
  const hrefs = await collectHrefsContaining(page, hrefPart);
  debug('found %s count=%d hrefs=%o', purpose, hrefs.length, hrefs);
  await page.$eval(selector, el => (el as HTMLElement).click());
  debug('clicked %s url=%s', purpose, sanitizeUrlForLog(page.url()));
  return hrefs;
}

function createLoginFields(credentials: ScraperSpecificCredentials) {
  return [
    { selector: usernameSelector, value: credentials.username },
    { selector: passwordSelector, value: credentials.password },
  ];
}

async function isLoggedIn(options: { page?: Page | undefined } | undefined) {
  if (!options?.page) {
    return false;
  }
  const oshXPath = `//a//span[contains(., "${checkingAccountTabHebrewName}") or contains(., "${checkingAccountTabEnglishName}")]`;
  const oshTab = await options.page.$$(`xpath${oshXPath}`);
  return oshTab.length > 0;
}

function getPossibleLoginResults(page: Page): PossibleLoginResults {
  return {
    [LoginResults.Success]: [AFTER_LOGIN_BASE_URL, isLoggedIn],
    [LoginResults.InvalidPassword]: [async () => !!(await page.$(invalidPasswordSelector))],
    [LoginResults.ChangePassword]: [CHANGE_PASSWORD_URL],
  };
}

function getStartMoment(optionsStartDate: Date) {
  const defaultStartMoment = moment().subtract(1, 'years');
  const startDate = optionsStartDate || defaultStartMoment.toDate();
  return moment.max(defaultStartMoment, moment(startDate));
}

async function getExtraTransactionDetails(
  page: Page,
  item: ScrapedTransaction,
  apiHeaders: Record<string, string>,
): Promise<MoreDetails> {
  try {
    debug('getExtraTransactionDetails for item:', item);
    if (item.MC02ShowDetailsEZ === '1') {
      const tarPeula = moment(item.MC02PeulaTaaEZ);
      const tarErech = moment(item.MC02ErehTaaEZ);

      const params = {
        inKodGorem: item.MC02KodGoremEZ,
        inAsmachta: item.MC02AsmahtaMekoritEZ,
        inSchum: item.MC02SchumEZ,
        inNakvanit: item.MC02KodGoremEZ,
        inSugTnua: item.MC02SugTnuaKaspitEZ,
        inAgid: item.MC02AgidEZ,
        inTarPeulaFormatted: tarPeula.format(DATE_FORMAT),
        inTarErechFormatted: (tarErech.year() > 2000 ? tarErech : tarPeula).format(DATE_FORMAT),
        inKodNose: item.MC02SeifMaralEZ,
        inKodTatNose: item.MC02NoseMaralEZ,
        inTransactionNumber: item.TransactionNumber,
      };

      const response = await fetchPostWithinPage<MoreDetailsResponse>(page, MORE_DETAILS_URL, params, apiHeaders);
      const details = response?.body.fields?.[0]?.[0]?.Records?.[0].Fields;
      debug('fetch details for', params, 'details:', details);
      if (Array.isArray(details) && details.length > 0) {
        const entries = details.map(record => [record.Label.trim(), record.Value.trim()]);
        return {
          entries: Object.fromEntries(entries),
          memo: entries
            .filter(([label]) => ['שם', 'מהות', 'חשבון'].some(key => label.startsWith(key)))
            .map(([label, value]) => `${label} ${value}`)
            .join(', '),
        };
      }
    }
  } catch (error) {
    debug('Error fetching extra transaction details:', error);
  }

  return {
    entries: {},
    memo: undefined,
  };
}

function parseYitra(raw: unknown): number | undefined {
  if (raw == null || raw === '') {
    return undefined;
  }
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function createDataFromRequest(request: HTTPRequest, optionsStartDate: Date) {
  const data = JSON.parse(request.postData() || '{}');

  data.inFromDate = getStartMoment(optionsStartDate).format(DATE_FORMAT);
  data.inToDate = moment().format(DATE_FORMAT);
  data.table.maxRow = MAX_ROWS_PER_REQUEST;

  return data;
}

function createHeadersFromRequest(request: HTTPRequest) {
  return {
    mizrahixsrftoken: request.headers().mizrahixsrftoken,
    'Content-Type': request.headers()['content-type'],
  };
}

function getTransactionIdentifier(row: ScrapedTransaction): string | number | undefined {
  if (!row.MC02AsmahtaMekoritEZ) {
    return undefined;
  }
  if (row.TransactionNumber && String(row.TransactionNumber) !== '1') {
    return `${row.MC02AsmahtaMekoritEZ}-${row.TransactionNumber}`;
  }
  return parseInt(row.MC02AsmahtaMekoritEZ, 10);
}

async function convertTransactions(
  txns: ScrapedTransaction[],
  getMoreDetails: (row: ScrapedTransaction) => Promise<MoreDetails>,
  pendingIfTodayTransaction: boolean = false,
  options?: ScraperOptions,
): Promise<Transaction[]> {
  return Promise.all(
    txns.map(async row => {
      const moreDetails = await getMoreDetails(row);

      const txnDate = moment(row.MC02PeulaTaaEZ, moment.HTML5_FMT.DATETIME_LOCAL_SECONDS).toISOString();

      const result: Transaction = {
        type: TransactionTypes.Normal,
        identifier: getTransactionIdentifier(row),
        date: txnDate,
        processedDate: txnDate,
        originalAmount: row.MC02SchumEZ,
        originalCurrency: SHEKEL_CURRENCY,
        chargedAmount: row.MC02SchumEZ,
        description: row.MC02TnuaTeurEZ,
        memo: moreDetails?.memo,
        status:
          pendingIfTodayTransaction && row.IsTodayTransaction
            ? TransactionStatuses.Pending
            : TransactionStatuses.Completed,
      };

      if (options?.includeRawTransaction) {
        result.rawTransaction = getRawTransaction({
          ...row,
          additionalInformation: moreDetails.entries,
        });
      }

      return result;
    }),
  );
}

async function extractPendingTransactions(page: Frame): Promise<Transaction[]> {
  const pendingTxn = await pageEvalAll(page, 'tr.rgRow, tr.rgAltRow', [], trs => {
    return trs.map(tr => Array.from(tr.querySelectorAll('td'), td => td.textContent || ''));
  });

  return pendingTxn
    .map(([dateStr, description, incomeAmountStr, amountStr]) => ({
      date: moment(dateStr, 'DD/MM/YY').toISOString(),
      amount: parseFloat(amountStr.replaceAll(',', '')),
      description,
      incomeAmountStr, // TODO: handle incomeAmountStr once we know the sign of it
    }))
    .filter(txn => txn.date)
    .map(({ date, description, amount }) => ({
      type: TransactionTypes.Normal,
      date,
      processedDate: date,
      originalAmount: amount,
      originalCurrency: SHEKEL_CURRENCY,
      chargedAmount: amount,
      description,
      status: TransactionStatuses.Pending,
    }));
}

async function postLogin(page: Page) {
  await Promise.race([
    waitUntilElementFound(page, afterLoginSelector),
    waitUntilElementFound(page, invalidPasswordSelector),
    waitForUrl(page, CHANGE_PASSWORD_URL),
  ]);
}

type ScraperSpecificCredentials = { username: string; password: string };

class MizrahiScraper extends BaseScraperWithBrowser<ScraperSpecificCredentials> {
  getLoginOptions(credentials: ScraperSpecificCredentials) {
    return {
      loginUrl: LOGIN_URL,
      fields: createLoginFields(credentials),
      submitButtonSelector,
      checkReadiness: async () => waitUntilElementDisappear(this.page, loginSpinnerSelector),
      postAction: async () => postLogin(this.page),
      possibleResults: getPossibleLoginResults(this.page),
    };
  }

  private logStep(phase: string, detail: string) {
    debug('%s %s url=%s', phase, detail, sanitizeUrlForLog(this.page.url()));
    this.emitProgress(phase, detail);
  }

  async fetchData() {
    this.logStep('MIZRAHI_ACCOUNTS', `looking for account dropdown ${accountDropDownItemSelector}`);
    try {
      await this.page.$eval('#dropdownBasic, .item', el => (el as HTMLElement).click());
    } catch (err) {
      throw new Error(
        `Mizrahi: looking for account dropdown (#dropdownBasic, .item) — not found. ${describeError(err)}`,
      );
    }

    const numOfAccounts = (await this.page.$$(accountDropDownItemSelector)).length;
    this.logStep('MIZRAHI_ACCOUNTS', `found ${numOfAccounts} account(s)`);

    try {
      const results: TransactionsAccount[] = [];

      for (let i = 0; i < numOfAccounts; i += 1) {
        if (i > 0) {
          await this.page.$eval('#dropdownBasic, .item', el => (el as HTMLElement).click());
        }

        this.logStep('MIZRAHI_ACCOUNTS', `select account ${i + 1}/${numOfAccounts}`);
        await this.page.$eval(`${accountDropDownItemSelector}:nth-child(${i + 1})`, el => (el as HTMLElement).click());
        results.push(await this.fetchAccount());
      }

      this.logStep(
        'MIZRAHI_DONE',
        `scraped ${results.length} account(s), txns=${results.reduce((sum, account) => sum + account.txns.length, 0)}`,
      );

      return {
        success: true,
        accounts: results,
      };
    } catch (e) {
      const errorMessage = describeError(e);
      debug('fetchData failed: %s', errorMessage);
      this.logStep('MIZRAHI_FAIL', errorMessage.slice(0, 400));
      return {
        success: false,
        errorType: ScraperErrorTypes.Generic,
        errorMessage: e instanceof Error ? e.message : errorMessage,
      };
    }
  }

  private async getPendingTransactions(): Promise<Transaction[]> {
    this.logStep('MIZRAHI_PENDING', `looking for pending page ${PENDING_TRANSACTIONS_PAGE}`);
    await clickHrefContaining(this.page, PENDING_TRANSACTIONS_PAGE, 'pending-transactions page');
    this.logStep('MIZRAHI_PENDING', `looking for iframe containing ${PENDING_TRANSACTIONS_IFRAME}`);
    const frame = await waitUntilIframeFound(this.page, f => f.url().includes(PENDING_TRANSACTIONS_IFRAME));
    debug('found pending iframe url=%s', sanitizeUrlForLog(frame.url()));
    const isPending = await waitUntilElementFound(frame, pendingTrxIdentifierId)
      .then(() => true)
      .catch(err => {
        debug('pending table %s not found: %s', pendingTrxIdentifierId, describeError(err));
        return false;
      });
    if (!isPending) {
      this.logStep('MIZRAHI_PENDING', `pending table ${pendingTrxIdentifierId} not found — 0 pending`);
      return [];
    }

    const pendingTxn = await extractPendingTransactions(frame);
    this.logStep('MIZRAHI_PENDING', `found ${pendingTxn.length} pending txn(s)`);
    return pendingTxn;
  }

  private async fetchAccount() {
    this.logStep('MIZRAHI_OSH', `looking for checking-account tab ${OSH_PAGE}`);
    await clickHrefContaining(this.page, OSH_PAGE, 'checking-account tab');

    this.logStep('MIZRAHI_TX_PAGE', `looking for transactions page ${TRANSACTIONS_PAGE}`);
    const txHrefs = await collectHrefsContaining(this.page, TRANSACTIONS_PAGE).catch(() => []);
    debug('transactions-page hrefs before click=%o', txHrefs);

    const lookedFor = TRANSACTIONS_REQUEST_URLS.map(sanitizeUrlForLog);
    this.logStep(
      'MIZRAHI_WAIT_API',
      `looking for TX API ${lookedFor.map(url => url.replace(BASE_APP_URL, '')).join(' | ')}`,
    );
    const sniffer = startRequestSniffer(this.page, TRANSACTIONS_REQUEST_URLS);

    try {
      // get428Index fires on the click; arm waiters first so we do not miss it
      // while reading the account number. The page's own reply usually has Yitra;
      // the later date-range replay often does not.
      const requestWaiters = TRANSACTIONS_REQUEST_URLS.map(url => {
        debug('waiting for response %s', sanitizeUrlForLog(url));
        return this.page
          .waitForResponse(res => res.url().split('?')[0] === url && res.request().method() === 'POST')
          .then(async res => {
            const request = res.request();
            debug('caught response %s %s', request.method(), sanitizeUrlForLog(request.url()));
            let pageYitra: unknown;
            try {
              const json = (await res.json()) as ScrapedTransactionsResult;
              pageYitra = json?.body?.fields?.Yitra;
            } catch (err) {
              debug('could not read page get428Index body %s', describeError(err));
            }
            return { url, request, pageYitra };
          });
      });
      requestWaiters.forEach(waiter => {
        void waiter.catch(() => undefined);
      });

      await clickHrefContaining(this.page, TRANSACTIONS_PAGE, 'transactions page');

      this.logStep('MIZRAHI_ACCOUNT', 'looking for account number #dropdownBasic b span');
      const accountNumberElement = await this.page.$('#dropdownBasic b span');
      const accountNumberHandle = await accountNumberElement?.getProperty('title');
      const accountNumber = (await accountNumberHandle?.jsonValue()) as string;
      if (!accountNumber) {
        throw new Error(
          `Mizrahi: looking for account number (#dropdownBasic b span) — not found. url=${sanitizeUrlForLog(this.page.url())}`,
        );
      }
      this.logStep('MIZRAHI_ACCOUNT', `found account ${accountNumber}`);

      let url: string;
      let request: HTTPRequest;
      let pageYitra: unknown;
      try {
        ({ url, request, pageYitra } = await Promise.any(requestWaiters));
      } catch (err) {
        const sniffed = sniffer.matchedRequests[0];
        if (!sniffed) {
          const frames = this.page.frames().map(frame => sanitizeUrlForLog(frame.url()));
          const seen = sniffer.seen.length ? sniffer.seen.join(', ') : 'none';
          const message = `Mizrahi TX API: all candidates failed. looked for: ${lookedFor.join(', ')}. seen requests: ${seen}. page=${sanitizeUrlForLog(this.page.url())}. frames=${frames.join(' | ') || 'none'}. ${describeError(err)}`;
          debug(message);
          throw new Error(message);
        }
        url = sniffed.url().split('?')[0];
        request = sniffed;
        debug('waitForRequest missed; using sniffed %s', sanitizeUrlForLog(url));
        this.logStep('MIZRAHI_WAIT_API', `waitForRequest missed — using sniffed ${sanitizeUrlForLog(url)}`);
      }

      const data = createDataFromRequest(request, this.options.startDate);
      const headers = createHeadersFromRequest(request);
      debug(
        'replay POST %s from=%s to=%s xsrf=%s',
        sanitizeUrlForLog(url),
        data.inFromDate,
        data.inToDate,
        Boolean(headers.mizrahixsrftoken),
      );
      const response = await fetchPostWithinPage<ScrapedTransactionsResult>(this.page, url, data, headers);
      const apiHeaders = headers;
      debug(
        'API response url=%s success=%s rows=%s yitra=%s',
        sanitizeUrlForLog(url),
        response?.header?.success,
        response?.body?.table?.rows?.length ?? 'n/a',
        response?.body?.fields?.Yitra ?? 'n/a',
      );

      if (!response || response.header.success === false) {
        throw new Error(
          `Error fetching transaction. Response message: ${response ? response.header.messages[0].text : ''}`,
        );
      }

      const relevantRows = response.body.table.rows.filter(row => row.RecTypeSpecified);
      const replayYitra = parseYitra(response.body.fields?.Yitra);
      const liveYitra = parseYitra(pageYitra);
      const balance = replayYitra ?? liveYitra;
      this.logStep(
        'MIZRAHI_API',
        `found ${response.body.table.rows.length} row(s), relevant=${relevantRows.length}, yitra=${replayYitra ?? 'n/a'}, pageYitra=${liveYitra ?? 'n/a'}`,
      );
      debug(
        'get428Index fields=%o replayYitra=%s pageYitra=%s',
        response.body.fields ? Object.keys(response.body.fields) : [],
        replayYitra ?? 'n/a',
        liveYitra ?? 'n/a',
      );
      const oshTxn = await convertTransactions(
        relevantRows,
        this.options.additionalTransactionInformation
          ? row => getExtraTransactionDetails(this.page, row, apiHeaders)
          : () => Promise.resolve({ entries: {}, memo: undefined }),
        this.options.optInFeatures?.includes('mizrahi:pendingIfTodayTransaction'),
        this.options,
      );

      oshTxn
        .filter(txn => this.shouldMarkAsPending(txn))
        .forEach(txn => {
          txn.status = TransactionStatuses.Pending;
        });

      // workaround for a bug which the bank's API returns transactions before the requested start date
      const startMoment = getStartMoment(this.options.startDate);
      const oshTxnAfterStartDate = oshTxn.filter(txn => moment(txn.date).isSameOrAfter(startMoment));
      debug(
        'date filter start=%s kept=%d dropped=%d',
        startMoment.format(DATE_FORMAT),
        oshTxnAfterStartDate.length,
        oshTxn.length - oshTxnAfterStartDate.length,
      );

      const pendingTxn = await this.getPendingTransactions();
      const allTxn = oshTxnAfterStartDate.concat(pendingTxn);
      this.logStep(
        'MIZRAHI_ACCOUNT',
        `account ${accountNumber} completed txns=${oshTxnAfterStartDate.length} pending=${pendingTxn.length}`,
      );

      return {
        accountNumber,
        txns: allTxn,
        ...(balance !== undefined ? { balance } : {}),
      };
    } finally {
      sniffer.stop();
    }
  }

  private shouldMarkAsPending(txn: Transaction): boolean {
    if (this.options.optInFeatures?.includes('mizrahi:pendingIfNoIdentifier') && !txn.identifier) {
      debug(`Marking transaction '${txn.description}' as pending due to no identifier.`);
      return true;
    }

    if (
      this.options.optInFeatures?.includes('mizrahi:pendingIfHasGenericDescription') &&
      genericDescriptions.includes(txn.description)
    ) {
      debug(`Marking transaction '${txn.description}' as pending due to generic description.`);
      return true;
    }

    return false;
  }
}

export default MizrahiScraper;
