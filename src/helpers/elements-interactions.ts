import { type Frame, type Page } from 'puppeteer';
import { waitUntil } from './waiting';

async function waitUntilElementFound(
  page: Page | Frame,
  elementSelector: string,
  onlyVisible = false,
  timeout?: number,
) {
  await page.waitForSelector(elementSelector, { visible: onlyVisible, timeout });
}

async function waitUntilElementInteractive(pageOrFrame: Page | Frame, elementSelector: string, timeout?: number) {
  await waitUntilElementFound(pageOrFrame, elementSelector, true, timeout);
  await pageOrFrame.waitForFunction(
    selector => {
      const element = document.querySelector(selector);
      if (!element) {
        return false;
      }
      const htmlElement = element as HTMLElement;
      if ((htmlElement as HTMLInputElement | HTMLButtonElement).disabled) {
        return false;
      }
      const rect = htmlElement.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    },
    { timeout },
    elementSelector,
  );
}

async function waitUntilElementDisappear(page: Page, elementSelector: string, timeout?: number) {
  await page.waitForSelector(elementSelector, { hidden: true, timeout });
}

async function waitUntilIframeFound(
  page: Page,
  framePredicate: (frame: Frame) => boolean,
  description = '',
  timeout = 30000,
) {
  let frame: Frame | undefined;
  await waitUntil(
    () => {
      frame = page.frames().find(framePredicate);
      return Promise.resolve(!!frame);
    },
    description,
    timeout,
    1000,
  );

  if (!frame) {
    throw new Error('failed to find iframe');
  }

  return frame;
}

async function fillInput(pageOrFrame: Page | Frame, inputSelector: string, inputValue: string): Promise<void> {
  if (typeof inputValue !== 'string') {
    throw new Error(`fillInput: expected string value for selector "${inputSelector}"`);
  }
  await waitUntilElementInteractive(pageOrFrame, inputSelector);
  await pageOrFrame.$eval(inputSelector, (input: Element) => {
    const inputElement = input;
    // @ts-ignore
    inputElement.value = '';
  });
  await pageOrFrame.type(inputSelector, inputValue, { delay: 20 });
}

async function setValue(pageOrFrame: Page | Frame, inputSelector: string, inputValue: string): Promise<void> {
  await waitUntilElementInteractive(pageOrFrame, inputSelector);
  await pageOrFrame.$eval(
    inputSelector,
    (input: Element, value) => {
      const inputElement = input;
      // @ts-ignore
      inputElement.value = value;
    },
    [inputValue],
  );
}

async function clickButton(pageOrFrame: Page | Frame, buttonSelector: string) {
  await waitUntilElementInteractive(pageOrFrame, buttonSelector);
  await pageOrFrame.$eval(buttonSelector, el => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    (el as HTMLElement).click();
  });
}

async function clickLink(page: Page, aSelector: string) {
  await waitUntilElementInteractive(page, aSelector);
  await page.$eval(aSelector, (el: any) => {
    if (!el || typeof el.click === 'undefined') {
      return;
    }

    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
  });
}

async function pageEvalAll<R>(
  page: Page | Frame,
  selector: string,
  defaultResult: any,
  callback: (elements: Element[], ...args: any) => R,
  ...args: any[]
): Promise<R> {
  let result = defaultResult;
  try {
    await page.waitForFunction(() => document.readyState === 'complete');
    result = await page.$$eval(selector, callback, ...args);
  } catch (e) {
    if (!(e as Error).message.startsWith('Error: failed to find elements matching selector')) {
      throw e;
    }
  }

  return result;
}

async function pageEval<R>(
  pageOrFrame: Page | Frame,
  selector: string,
  defaultResult: any,
  callback: (elements: Element, ...args: any) => R,
  ...args: any[]
): Promise<R> {
  let result = defaultResult;
  try {
    await pageOrFrame.waitForFunction(() => document.readyState === 'complete');
    result = await pageOrFrame.$eval(selector, callback, ...args);
  } catch (e) {
    if (!(e as Error).message.startsWith('Error: failed to find element matching selector')) {
      throw e;
    }
  }

  return result;
}

async function elementPresentOnPage(pageOrFrame: Page | Frame, selector: string) {
  return (await pageOrFrame.$(selector)) !== null;
}

async function dropdownSelect(page: Page, selectSelector: string, value: string) {
  await waitUntilElementInteractive(page, selectSelector);
  await page.select(selectSelector, value);
}

async function dropdownElements(page: Page, selector: string) {
  const options = await page.evaluate(optionSelector => {
    return Array.from(document.querySelectorAll<HTMLOptionElement>(optionSelector))
      .filter(o => o.value)
      .map(o => {
        return {
          name: o.text,
          value: o.value,
        };
      });
  }, `${selector} > option`);
  return options;
}

export {
  clickButton,
  clickLink,
  dropdownElements,
  dropdownSelect,
  elementPresentOnPage,
  fillInput,
  pageEval,
  pageEvalAll,
  setValue,
  waitUntilElementDisappear,
  waitUntilElementFound,
  waitUntilElementInteractive,
  waitUntilIframeFound,
};
