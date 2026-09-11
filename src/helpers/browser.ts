import { type Page } from 'puppeteer';

/**
 * Default Chromium flags that reduce automation fingerprinting.
 * Merged with any user-provided args in BaseScraperWithBrowser.
 */
export const defaultBrowserArgs = ['--disable-blink-features=AutomationControlled'];

export async function maskHeadlessUserAgent(page: Page): Promise<void> {
  const userAgent = await page.evaluate(() => navigator.userAgent);
  await page.setUserAgent(userAgent.replace('HeadlessChrome/', 'Chrome/'));
}

/**
 * Apply common anti-detection measures before navigating to bank sites.
 * Must be called before the first navigation on a new page.
 */
export async function preparePageForScraping(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });

    Object.defineProperty(navigator, 'languages', {
      get: () => ['he-IL', 'he', 'en-US', 'en'],
    });
  });

  await maskHeadlessUserAgent(page);
}

/**
 * Priorities for request interception. The higher the number, the higher the priority.
 * We want to let others to have the ability to override our interception logic therefore we hardcode them.
 */
export const interceptionPriorities = {
  abort: 1000,
  continue: 10,
};
