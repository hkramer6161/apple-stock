import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Checker, defaultSettings, postalCodeFits } from '../src/checker.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('country defaults from COUNTRY and is validated', () => {
  assert.equal(defaultSettings({}).country, 'ca');
  assert.equal(defaultSettings({ COUNTRY: 'US' }).country, 'us');
  assert.throws(() => defaultSettings({ COUNTRY: 'usa' }));
});

test('postal codes are checked against the country format', () => {
  assert.ok(postalCodeFits('M5V3L9', 'ca'));
  assert.ok(!postalCodeFits('10001', 'ca'));
  assert.ok(postalCodeFits('10001', 'us'));
  assert.ok(postalCodeFits('10001-1234', 'us'));
  assert.ok(!postalCodeFits('M5V3L9', 'us'));
  assert.ok(postalCodeFits('SW1A1AA', 'uk'));
});

test('switching country resets models and a postal code that no longer fits', async () => {
  const checker = new Checker({ env: { POSTAL_CODE: 'M5V 3L9' }, log: () => {} });
  checker.settings.model = 'MK244VC/A';
  assert.equal(await checker.updateSettings({ country: 'us' }), true);
  assert.equal(checker.settings.country, 'us');
  assert.equal(checker.settings.postalCode, '');
  assert.equal(checker.settings.model, 'all');
  await checker.updateSettings({ postalCode: '10001' });
  assert.equal(checker.settings.postalCode, '10001');
  checker.settings.postalCode = 'ABCDE';
  await assert.rejects(checker.checkOnce(), /valid zip code/);
  await assert.rejects(checker.updateSettings({ country: 'u$' }));
});

test('country update waits for an in-flight check before closing the browser', async () => {
  const checker = new Checker({ env: {}, log: () => {} });
  const checkGate = deferred();
  const closeCalls = [];
  checker.store = {
    country: 'ca',
    browser: {},
    async close() {
      closeCalls.push(this.country);
    },
    async listProducts() {
      return [];
    },
  };
  checker.loadVariants = async () => {};
  checker.runCheck = async () => checkGate.promise;

  const check = checker.check();
  const update = checker.updateSettings({ country: 'us' });
  await Promise.resolve();
  assert.deepEqual(closeCalls, []);
  assert.equal(checker.store.country, 'ca');
  assert.equal(checker.settings.country, 'ca');

  checkGate.resolve();
  await Promise.all([check, update]);
  assert.deepEqual(closeCalls, ['ca']);
  assert.equal(checker.store.country, 'us');
  assert.equal(checker.settings.country, 'us');
});

test('check requested during a country switch waits for matching settings and store', async () => {
  const checker = new Checker({ env: {}, log: () => {} });
  const productsGate = deferred();
  const variantsGate = deferred();
  const variantsStarted = deferred();
  let runCheckCountry;
  checker.store = {
    country: 'ca',
    async close() {},
    async listProducts() {
      return productsGate.promise;
    },
  };
  checker.loadVariants = async () => {
    variantsStarted.resolve();
    await variantsGate.promise;
  };
  checker.runCheck = async () => {
    runCheckCountry = [checker.settings.country, checker.store.country];
  };

  const update = checker.updateSettings({ country: 'us' });
  await Promise.resolve();
  const check = checker.check();
  assert.equal(runCheckCountry, undefined);

  productsGate.resolve([{ slug: 'buy-iphone/iphone-duo', name: 'iPhone Duo' }]);
  await variantsStarted.promise;
  assert.equal(runCheckCountry, undefined);
  variantsGate.resolve();
  await Promise.all([update, check]);
  assert.deepEqual(runCheckCountry, ['us', 'us']);
});

test('queued updates and a check complete in call order', async () => {
  const checker = new Checker({ env: {}, log: () => {} });
  const firstProducts = deferred();
  const secondProducts = deferred();
  const secondProductsStarted = deferred();
  const events = [];
  let listCount = 0;
  checker.store = {
    country: 'ca',
    async close() {},
    async listProducts() {
      listCount++;
      events.push(`products:${this.country}`);
      if (listCount === 2) secondProductsStarted.resolve();
      return listCount === 1 ? firstProducts.promise : secondProducts.promise;
    },
  };
  checker.loadVariants = async () => {
    events.push(`variants:${checker.store.country}`);
  };
  checker.runCheck = async () => {
    events.push(`check:${checker.settings.country}:${checker.store.country}`);
  };

  const first = checker.updateSettings({ country: 'us' });
  const second = checker.updateSettings({ country: 'ca' });
  const check = checker.check();
  firstProducts.resolve([{ slug: 'buy-iphone/iphone-duo', name: 'iPhone Duo' }]);
  await secondProductsStarted.promise;
  assert.deepEqual(events, ['products:us', 'variants:us', 'products:ca']);
  secondProducts.resolve([{ slug: 'buy-iphone/iphone-duo', name: 'iPhone Duo' }]);

  await Promise.all([first, second, check]);
  assert.deepEqual(events, [
    'products:us',
    'variants:us',
    'products:ca',
    'variants:ca',
    'check:ca:ca',
  ]);
});

test('failed settings updates do not block later updates or pending checks', async () => {
  const checker = new Checker({ env: {}, log: () => {} });
  const events = [];
  checker.runCheck = async () => {
    events.push(`check:${checker.settings.emailTo}`);
  };

  const failedUpdate = checker.updateSettings({ country: 'u$' });
  const check = checker.check();
  const validUpdate = checker.updateSettings({ emailTo: 'stock@example.com' });

  await assert.rejects(failedUpdate, /unsupported country/);
  await Promise.all([check, validUpdate]);
  assert.equal(checker.settings.emailTo, 'stock@example.com');
  assert.deepEqual(events, ['check:']);
});

test('empty UK postal code is rejected before opening the browser', async () => {
  const checker = new Checker({ env: {}, log: () => {} });
  let opened = false;
  checker.settings.country = 'uk';
  checker.settings.postalCode = '';
  checker.store = {
    async open() {
      opened = true;
    },
  };

  await assert.rejects(checker.checkOnce(), /valid postal code/);
  assert.equal(opened, false);
});
