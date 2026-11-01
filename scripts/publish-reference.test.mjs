import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { CML, Emulator, Lucid } from '@lucid-evolution/lucid';
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { UsageError } from './lib/deployment.mjs';
import {
  ALWAYS_FAIL_SCRIPT,
  alwaysFailAddress,
  buildPublishTx,
  formatSummary,
  publishReference,
} from './publish-reference.mjs';
import {
  BLUEPRINT,
  ROOT,
  assertBadInput,
  bech32Decode,
  bech32Encode,
  madeUpKeyHash,
  runScript,
  tempDirs,
} from './test-helpers.mjs';

// Everything here is offline: transactions are built against Lucid Evolution's Emulator, never a
// real provider, and nothing is signed or submitted. The expected values are worked out here from
// the transaction bytes and the protocol parameters, not taken from the code under test.

const dirs = tempDirs();
after(() => dirs.cleanup());

/** A preprod enterprise key address, made by hand from a made-up key hash. No key behind it. */
const FROM = bech32Encode('addr_test', Uint8Array.from([0x60, ...hexToBytes(madeUpKeyHash('deployer'))]));
const MAINNET_FROM = bech32Encode('addr', Uint8Array.from([0x61, ...hexToBytes(madeUpKeyHash('deployer'))]));

const unapplied = JSON.parse(readFileSync(BLUEPRINT, 'utf8')).validators[0];
const SCRIPT = { scriptHash: unapplied.hash, compiledCode: unapplied.compiledCode };

/** A Lucid on an Emulator ledger in which `from` holds `lovelace` in a single UTxO. */
async function emulatorLucid(lovelace = 1_000_000_000n, from = FROM) {
  const utxos = lovelace === 0n ? [] : [{ address: from, assets: { lovelace } }];
  return Lucid(new Emulator(utxos), 'Preprod');
}

/** A deployments folder with `preprod-v<version>/script.json` holding `script`. */
function deploymentsWith(script, version = 1) {
  const dir = dirs.make('publish-');
  const folder = join(dir, `preprod-v${version}`);
  mkdirSync(folder, { recursive: true });
  if (script !== undefined) writeFileSync(join(folder, 'script.json'), `${JSON.stringify(script, null, 2)}\n`);
  return dir;
}

const transaction = (cbor) => CML.Transaction.from_cbor_hex(cbor);
const outputsOf = (cbor) => {
  const outputs = transaction(cbor).body().outputs();
  return Array.from({ length: outputs.len() }, (_, i) => outputs.get(i));
};

// ---------------------------------------------------------------------------------------------
// The always-fail address

test('the always-fail address is the enterprise script address of `any []`, hashed from hand-built CBOR', () => {
  assert.deepEqual(ALWAYS_FAIL_SCRIPT, { type: 'any', scripts: [] });
  // Native script `any []` is [2, []] = 82 02 80; its hash is blake2b-224 over the tag 00 and that CBOR.
  const hash = bytesToHex(blake2b(Uint8Array.from([0x00, 0x82, 0x02, 0x80]), { dkLen: 28 }));
  const { hrp, bytes } = bech32Decode(alwaysFailAddress());
  assert.equal(hrp, 'addr_test');
  assert.equal(bytes.length, 29, 'an enterprise address: header and one 28-byte credential');
  assert.equal(bytes[0], 0x70, 'type 7 (script, no stake part), network 0 (preprod)');
  assert.equal(bytesToHex(bytes.slice(1)), hash);
});

// ---------------------------------------------------------------------------------------------
// The transaction

test('one output at the always-fail address holds the script as a reference script, no datum, minimum ADA', async () => {
  const lucid = await emulatorLucid();
  const built = await buildPublishTx({ lucid, compiledCode: SCRIPT.compiledCode, from: FROM });
  const outputs = outputsOf(built.txCbor);
  const atAlwaysFail = outputs.filter((o) => o.address().to_bech32() === alwaysFailAddress());
  assert.equal(atAlwaysFail.length, 1, 'exactly one output at the always-fail address');
  const [locked] = atAlwaysFail;

  assert.equal(locked.script_ref().hash().to_hex(), SCRIPT.scriptHash, 'the reference script is the applied script');
  assert.equal(locked.script_ref().kind(), 3, 'Plutus V3');
  assert.equal(locked.datum(), undefined, 'no datum: neither a hash nor an inline datum');

  // The ledger minimum for an output: (160 + its serialised size) * coinsPerUtxoByte.
  const { coinsPerUtxoByte } = lucid.config().protocolParameters;
  const minimum = BigInt(160 + locked.to_cbor_bytes().length) * coinsPerUtxoByte;
  const lovelace = locked.amount().coin();
  assert.ok(lovelace >= minimum, `${lovelace} lovelace is below the ledger minimum ${minimum}`);
  assert.ok(lovelace - minimum < 10n * coinsPerUtxoByte, `${lovelace} lovelace is well above the minimum ${minimum}`);
  assert.equal(locked.amount().multi_asset().keys().len(), 0, 'ADA only');
});

test('the rest goes back to --from as change and the transaction balances', async () => {
  const funds = 1_000_000_000n;
  const lucid = await emulatorLucid(funds);
  const built = await buildPublishTx({ lucid, compiledCode: SCRIPT.compiledCode, from: FROM });
  const body = transaction(built.txCbor).body();
  const outputs = outputsOf(built.txCbor);
  assert.equal(outputs.length, 2, 'the locked output and the change');
  const change = outputs.find((o) => o.address().to_bech32() !== alwaysFailAddress());
  assert.equal(change.address().to_bech32(), FROM);
  assert.equal(change.script_ref(), undefined);
  assert.equal(change.datum(), undefined);

  const locked = outputs.find((o) => o.address().to_bech32() === alwaysFailAddress());
  assert.equal(locked.amount().coin() + change.amount().coin() + body.fee(), funds, 'inputs = outputs + fee');
  assert.equal(body.inputs().len(), 1);
  assert.equal(body.certs(), undefined);
  assert.equal(body.withdrawals(), undefined);
  assert.equal(body.mint(), undefined);
  assert.equal(body.collateral_inputs(), undefined);
  assert.equal(body.reference_inputs(), undefined);
});

test('the transaction is unsigned: an empty witness set, no scripts, valid flag, no auxiliary data', async () => {
  const lucid = await emulatorLucid();
  const { txCbor } = await buildPublishTx({ lucid, compiledCode: SCRIPT.compiledCode, from: FROM });
  const tx = transaction(txCbor);
  assert.equal(tx.witness_set().to_cbor_hex(), 'a0', 'an empty map');
  assert.equal(tx.witness_set().vkeywitnesses(), undefined);
  assert.equal(tx.is_valid(), true);
  assert.equal(tx.auxiliary_data(), undefined);
  assert.match(txCbor, /^[0-9a-f]+$/);
});

test('the summary reports the always-fail address, the script hash, the output lovelace and the fee as built', async () => {
  const lucid = await emulatorLucid();
  const built = await buildPublishTx({ lucid, compiledCode: SCRIPT.compiledCode, from: FROM });
  const body = transaction(built.txCbor).body();
  const locked = outputsOf(built.txCbor).find((o) => o.address().to_bech32() === alwaysFailAddress());
  assert.equal(built.alwaysFailAddress, alwaysFailAddress());
  assert.equal(built.scriptHash, SCRIPT.scriptHash);
  assert.equal(built.outputLovelace, locked.amount().coin());
  assert.equal(built.fee, body.fee());

  const text = formatSummary(built);
  for (const value of [alwaysFailAddress(), SCRIPT.scriptHash, String(built.outputLovelace), String(built.fee)]) {
    assert.ok(text.includes(value), `the summary names ${value}`);
  }
});

test('it is repeatable: the same ledger and script give the same transaction', async () => {
  const first = await buildPublishTx({ lucid: await emulatorLucid(), compiledCode: SCRIPT.compiledCode, from: FROM });
  const second = await buildPublishTx({ lucid: await emulatorLucid(), compiledCode: SCRIPT.compiledCode, from: FROM });
  assert.equal(first.txCbor, second.txCbor);
});

test('an address with no UTxOs, or too little ADA, is refused with a message that says what to do', async () => {
  await assert.rejects(
    buildPublishTx({ lucid: await emulatorLucid(0n), compiledCode: SCRIPT.compiledCode, from: FROM }),
    (error) => error instanceof UsageError && /no UTxOs/i.test(error.message) && error.message.includes(FROM),
  );
  await assert.rejects(
    buildPublishTx({ lucid: await emulatorLucid(2_000_000n), compiledCode: SCRIPT.compiledCode, from: FROM }),
    (error) => error instanceof UsageError && /cannot build/i.test(error.message),
  );
});

test('bad --from addresses are refused: mainnet, a script address, a stake address, garbage, upper case', async () => {
  const lucid = await emulatorLucid();
  const scriptAddress = bech32Encode('addr_test', Uint8Array.from([0x70, ...hexToBytes(madeUpKeyHash('script'))]));
  const rewardAddress = bech32Encode('stake_test', Uint8Array.from([0xe0, ...hexToBytes(madeUpKeyHash('stake'))]));
  const bad = [MAINNET_FROM, scriptAddress, alwaysFailAddress(), rewardAddress, 'addr_test1notanaddress', '', FROM.toUpperCase(), undefined, 42];
  for (const from of bad) {
    await assert.rejects(
      buildPublishTx({ lucid, compiledCode: SCRIPT.compiledCode, from }),
      (error) => error instanceof UsageError && /--from/.test(error.message),
      String(from),
    );
  }
});

test('a compiledCode that is not hex is refused before anything is built', async () => {
  const lucid = await emulatorLucid();
  for (const compiledCode of ['', 'zz', 'abc', undefined, 7]) {
    await assert.rejects(buildPublishTx({ lucid, compiledCode, from: FROM }), UsageError, String(compiledCode));
  }
});

// ---------------------------------------------------------------------------------------------
// From a deployment folder (what the command line does, with the provider swapped for the Emulator)

test('publishReference reads preprod-v<N>/script.json and builds the transaction for that script', async () => {
  const dir = deploymentsWith(SCRIPT, 7);
  const built = await publishReference({ network: 'preprod', version: 7, from: FROM, dir, makeLucid: () => emulatorLucid() });
  assert.equal(built.scriptHash, SCRIPT.scriptHash);
  const locked = outputsOf(built.txCbor).filter((o) => o.address().to_bech32() === alwaysFailAddress());
  assert.equal(locked.length, 1);
  assert.equal(locked[0].script_ref().hash().to_hex(), SCRIPT.scriptHash);
});

test('the committed preprod-v1 script builds and its reference script hash is the one in script.json', async () => {
  const deployed = JSON.parse(readFileSync(join(ROOT, 'deployments', 'preprod-v1', 'script.json'), 'utf8'));
  const built = await publishReference({ network: 'preprod', version: 1, from: FROM, makeLucid: () => emulatorLucid() });
  assert.equal(built.scriptHash, deployed.scriptHash);
  const locked = outputsOf(built.txCbor).find((o) => o.address().to_bech32() === alwaysFailAddress());
  assert.equal(locked.script_ref().hash().to_hex(), deployed.scriptHash);
});

test('publishReference refuses mainnet and anything that is not preprod, before it reads a file or makes a provider', async () => {
  let providers = 0;
  const makeLucid = () => {
    providers += 1;
    return emulatorLucid();
  };
  const dir = deploymentsWith(SCRIPT);
  for (const network of ['mainnet', 'Preprod', 'preview', 'devnet', '', undefined, 'constructor']) {
    await assert.rejects(
      publishReference({ network, version: 1, from: FROM, dir, makeLucid }),
      (error) => error instanceof UsageError && /preprod/.test(error.message),
      String(network),
    );
  }
  assert.equal(providers, 0, 'no provider was made');
});

test('a missing script.json, or one that does not hash to its scriptHash, is refused', async () => {
  const makeLucid = () => emulatorLucid();
  await assert.rejects(
    publishReference({ network: 'preprod', version: 1, from: FROM, dir: deploymentsWith(undefined), makeLucid }),
    (error) => error instanceof UsageError && /script\.json/.test(error.message),
  );
  await assert.rejects(
    publishReference({ network: 'preprod', version: 1, from: FROM, dir: dirs.make('publish-empty-'), makeLucid }),
    (error) => error instanceof UsageError && /script\.json/.test(error.message),
  );
  const wrongHash = deploymentsWith({ ...SCRIPT, scriptHash: '00'.repeat(28) });
  await assert.rejects(
    publishReference({ network: 'preprod', version: 1, from: FROM, dir: wrongHash, makeLucid }),
    (error) => error instanceof UsageError && /hash/.test(error.message),
  );
  for (const broken of [{}, { scriptHash: 'xyz', compiledCode: 'zz' }, { scriptHash: SCRIPT.scriptHash }, { compiledCode: SCRIPT.compiledCode }]) {
    await assert.rejects(
      publishReference({ network: 'preprod', version: 1, from: FROM, dir: deploymentsWith(broken), makeLucid }),
      (error) => error instanceof UsageError && /script\.json/.test(error.message),
      JSON.stringify(broken),
    );
  }
});

// ---------------------------------------------------------------------------------------------
// The real Koios provider, with `fetch` stubbed (still offline)

const KOIOS = 'https://preprod.koios.rest/api/v1';

/** The `epoch_params` row Koios answers with, in the shape the provider's schema reads, from the Emulator's parameters. */
function koiosEpochParams(pp) {
  return [{
    pvt_motion_no_confidence: 0.51, pvt_committee_normal: 0.51, pvt_committee_no_confidence: 0.51, pvt_hard_fork_initiation: 0.51,
    pvtpp_security_group: 0.51, dvt_motion_no_confidence: 0.67, dvt_committee_normal: 0.67, dvt_committee_no_confidence: 0.6,
    dvt_update_to_constitution: 0.75, dvt_hard_fork_initiation: 0.6, dvt_p_p_network_group: 0.67, dvt_p_p_economic_group: 0.67,
    dvt_p_p_technical_group: 0.67, dvt_p_p_gov_group: 0.75, dvt_treasury_withdrawal: 0.67, committee_min_size: 7,
    committee_max_term_length: 146, gov_action_lifetime: 6, gov_action_deposit: String(pp.govActionDeposit),
    drep_deposit: String(pp.drepDeposit), drep_activity: 20, min_fee_ref_script_cost_per_byte: pp.minFeeRefScriptCostPerByte,
    epoch_no: 200, min_fee_a: pp.minFeeA, min_fee_b: pp.minFeeB, max_block_size: 90112, max_tx_size: pp.maxTxSize, max_bh_size: 1100,
    key_deposit: String(pp.keyDeposit), pool_deposit: String(pp.poolDeposit), max_epoch: 18, optimal_pool_count: 500, influence: 0.3,
    monetary_expand_rate: 0.003, treasury_growth_rate: 0.2, decentralisation: 0, extra_entropy: null, protocol_major: 10,
    protocol_minor: 0, min_utxo_value: '0', min_pool_cost: '170000000', nonce: '00', block_hash: null,
    cost_models: { PlutusV1: pp.costModels.PlutusV1, PlutusV2: pp.costModels.PlutusV2, PlutusV3: pp.costModels.PlutusV3 },
    price_mem: pp.priceMem, price_step: pp.priceStep, max_tx_ex_mem: Number(pp.maxTxExMem), max_tx_ex_steps: Number(pp.maxTxExSteps),
    max_block_ex_mem: 62000000, max_block_ex_steps: 20000000000, max_val_size: pp.maxValSize,
    collateral_percent: pp.collateralPercentage, max_collateral_inputs: pp.maxCollateralInputs,
    coins_per_utxo_size: String(pp.coinsPerUtxoByte),
  }];
}

const koiosAddressInfo = (address, lovelace) => [{
  address,
  balance: String(lovelace),
  stake_address: null,
  script_address: false,
  utxo_set: [{
    tx_hash: 'aa'.repeat(32), tx_index: 0, block_time: 1, block_height: 1, value: String(lovelace),
    datum_hash: null, inline_datum: null, reference_script: null, asset_list: [],
  }],
}];

test('through the real Koios provider (fetch stubbed): two public preprod requests, no API key, the same kind of transaction', async () => {
  const reference = await emulatorLucid();
  const params = koiosEpochParams(reference.config().protocolParameters);
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const raw = init.body ?? undefined;
    requests.push({
      method: init.method ?? 'GET',
      url,
      body: raw === undefined ? undefined : typeof raw === 'string' ? raw : new TextDecoder().decode(raw),
      authorization: new Headers(init.headers).get('authorization'),
    });
    const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url === `${KOIOS}/epoch_params?limit=1`) return json(params);
    if (url === `${KOIOS}/address_info`) return json(koiosAddressInfo(FROM, 1_000_000_000));
    throw new Error(`unexpected request to ${url}`); // nothing else may leave the process
  };
  let built;
  try {
    built = await publishReference({ network: 'preprod', version: 1, from: FROM, dir: deploymentsWith(SCRIPT) });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.deepEqual(
    [...new Set(requests.map((r) => `${r.method} ${r.url}`))].sort(),
    [`GET ${KOIOS}/epoch_params?limit=1`, `POST ${KOIOS}/address_info`],
  );
  assert.deepEqual(JSON.parse(requests.find((r) => r.method === 'POST').body), { _addresses: [FROM] });
  assert.ok(requests.every((r) => !r.authorization), 'no API key or token is sent');

  const locked = outputsOf(built.txCbor).filter((o) => o.address().to_bech32() === alwaysFailAddress());
  assert.equal(locked.length, 1);
  assert.equal(locked[0].script_ref().hash().to_hex(), SCRIPT.scriptHash);
  assert.equal(transaction(built.txCbor).witness_set().to_cbor_hex(), 'a0');
  assert.equal(transaction(built.txCbor).body().inputs().get(0).transaction_id().to_hex(), 'aa'.repeat(32));
});

// ---------------------------------------------------------------------------------------------
// The command line (only the paths that end before any provider is made)

const publish = (args) => runScript('publish-reference.mjs', args);

test('--network mainnet exits 2 with a message and prints nothing on stdout', () => {
  const dir = deploymentsWith(SCRIPT);
  const result = publish(['--network=mainnet', '--version=1', `--from=${FROM}`, `--dir=${dir}`]);
  assertBadInput(result, /preprod/i, 'mainnet');
  assert.match(result.stderr, /mainnet/);
});

test('other networks, a missing script.json, bad --from, bad version and unknown options all exit 2', () => {
  const dir = deploymentsWith(SCRIPT);
  const base = ['--network=preprod', '--version=1', `--from=${FROM}`, `--dir=${dir}`];
  const without = (name) => base.filter((arg) => !arg.startsWith(name));
  assertBadInput(publish(['--network=preview', ...base.slice(1)]), /preprod/, 'preview');
  assertBadInput(publish(['--network=devnet', ...base.slice(1)]), /preprod|network/, 'devnet');
  assertBadInput(publish(without('--network')), /network/, 'no network');
  assertBadInput(publish(without('--version')), /version/, 'no version');
  assertBadInput(publish(without('--from')), /from/, 'no from');
  assertBadInput(publish([...base.slice(0, 1), '--version=0', ...base.slice(2)]), /version/, 'version 0');
  assertBadInput(publish([...base, '--bogus=1']), /bogus/, 'unknown option');
  assertBadInput(publish([...base.slice(0, 2), `--from=${MAINNET_FROM}`, base[3]]), /--from/, 'mainnet from address');
  assertBadInput(publish([...base.slice(0, 2), '--from=not-an-address', base[3]]), /--from/, 'garbage from address');

  const empty = dirs.make('publish-empty-');
  assertBadInput(publish([...base.slice(0, 3), `--dir=${empty}`]), /script\.json/, 'no preprod-v1 folder');
  const noScript = deploymentsWith(undefined);
  assertBadInput(publish([...base.slice(0, 3), `--dir=${noScript}`]), /script\.json/, 'no script.json');
});

// ---------------------------------------------------------------------------------------------
// It never touches a key

test('the script reads no key file, signs nothing and submits nothing', () => {
  const source = readFileSync(join(ROOT, 'scripts', 'publish-reference.mjs'), 'utf8');
  // Only the code: the header comment talks about what the script does not do.
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join('\n');
  for (const word of [
    'gero-market-keys', '.skey', '.vkey', 'SigningKey', 'PrivateKey', 'privateKey', 'fromSeed', 'fromPrivateKey',
    'selectWallet.fromSeed', '.sign', 'submit', 'homedir', 'process.env',
  ]) {
    assert.ok(!code.includes(word), `the code mentions ${word}`);
  }
  // The only file it reads is script.json.
  const reads = [...code.matchAll(/readFileSync\(|readJsonFile\(|readdirSync\(|openSync\(/g)].length;
  assert.ok(reads <= 1, `${reads} file reads`);
});
