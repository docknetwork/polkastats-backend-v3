// @ts-check
const { BigNumber } = require('bignumber.js');
const { getDisplayName } = require('../utils.js');
const pino = require('pino');
const axios = require('axios');
const logger = pino();

const loggerOptions = {
  crawler: `poa-validators`
};

async function getValidatorAddresses() {
  logger.info(loggerOptions, `getValidatorAddresses`);
  const addressUri = 'https://gist.githubusercontent.com/lovesh/c540b975774735fe0001c86fa47a91b3/raw';
  await axios.get(addressUri);
}

module.exports = {
  start: async function (api, pool, _config) {
    logger.info(loggerOptions, `Starting staking crawler...`);

    let currentKnownSessionIndex;

    // Get last era index stored in DB
    const sqlSelect = `SELECT session_index FROM validator ORDER BY session_index DESC LIMIT 1`;
    const res = await pool.query(sqlSelect);
    if (res.rows.length > 0) {
      currentKnownSessionIndex = parseInt(res.rows[0]["session_index"]);
      logger.info(loggerOptions, `Last session index stored in DB is #${currentKnownSessionIndex}`);
    } else {
      logger.info(loggerOptions, `First execution, no session index found in DB!`);

      const sessionInfo = await api.derive.session.info();
      const currentEraIndex = sessionInfo.activeEra.toNumber();
      const currentSessionIndex = sessionInfo.currentIndex.toNumber();
      currentKnownSessionIndex = currentSessionIndex;

      const block = await api.rpc.chain.getBlock();
      const blockNumber = block.block.header.number.toNumber();
      await module.exports.storeSessionStakingInfo(api, pool, blockNumber, sessionInfo, currentEraIndex);
    }

    // Subscribe to new blocks
    await api.rpc.chain.subscribeNewHeads(async (header) => {

      const blockNumber = header.number.toNumber();

      const sessionInfo = await api.derive.session.info();
      const currentEraIndex = sessionInfo.activeEra.toNumber();
      const currentSessionIndex = sessionInfo.currentIndex.toNumber();

      if (currentSessionIndex > currentKnownSessionIndex) {
        currentKnownSessionIndex = currentSessionIndex;
        await module.exports.storeSessionStakingInfo(api, pool, blockNumber, sessionInfo, currentEraIndex);
      }
    });
  },
  storeSessionStakingInfo: async function (api, pool, blockNumber, sessionInfo, currentEraIndex) {
    // Start execution
    const startTime = new Date().getTime();
    const currentIndex = sessionInfo.currentIndex.toNumber();
    logger.info(loggerOptions, `Storing validators staking info for session #${currentIndex} (block #${blockNumber})`);

    //
    // Get active validators, next elected and nominators
    //
    const [validatorAddresses] = await Promise.all([
      api.query.session.validators(),
    ]);

    // Get all nominator identities
    const validatorStaking = await Promise.all(
      validatorAddresses.map(accountId => api.derive.accounts.info(accountId))
    );

    const hardcodedAddresses = await getValidatorAddresses();

    //
    // Populate validator table
    //
    for(let i = 0; i < validatorStaking.length; i++) {
      const validator = validatorStaking[i];

      validator.exposure = {
        total: 1,
        own: 1,
        others: 1,
      };

      validator.controllerId = validator.accountId;
      validator.stashId = validator.accountId;
      validator.rank = 0;

      validator.stakers = [];
      validator.validatorPrefs = {
        commission: false,
      };
      validator.nominators = [];
      validator.displayName = hardcodedAddresses[validator.accountId] || validator.accountId;
      validator.rewardDestination = validator.accountId;
      validator.nextSessionIds = '';
      validator.stakingLedger = '';
      validator.sessionIds = '';
      validator.sessionIdHex = '';
      validator.nextSessionIdHex = '';
      validator.redeemable = '';
      validator.nextElected = false;

      const sql = `
        INSERT INTO validator (
          block_height,
          session_index,
          account_id,
          controller_id,
          stash_id,
          rank,
          stakers,
          identity,
          display_name,
          exposure,
          exposure_total,
          exposure_own,
          exposure_others,
          nominators,
          reward_destination,
          staking_ledger,
          validator_prefs,
          commission,
          session_ids,
          next_session_ids,
          session_id_hex,
          next_session_id_hex,
          redeemable,
          next_elected,
          produced_blocks,
          timestamp
        ) VALUES (
          '${blockNumber}',
          '${currentIndex}',
          '${validator.accountId}',
          '${validator.controllerId}',
          '${validator.stashId}',
          '${validator.rank}',
          '${JSON.stringify(validator.stakers)}',
          '${JSON.stringify(validator.identity)}',
          '${validator.displayName}',
          '${JSON.stringify(validator.exposure)}',
          '${validator.exposure.total}',
          '${validator.exposure.own}',
          '${validator.exposure.others}',
          '${JSON.stringify(validator.nominators)}',
          '${validator.rewardDestination}',
          '${validator.stakingLedger}',
          '${JSON.stringify(validator.validatorPrefs)}',
          '${validator.validatorPrefs.commission}',
          '${validator.sessionIds}',
          '${validator.nextSessionIds}',
          '${validator.sessionIdHex}',
          '${validator.nextSessionIdHex}',
          '${validator.redeemable}',
          '${validator.nextElected}',
          0,
          '${Date.now()}'
        )`;
      try {
        await pool.query(sql);
      } catch (error) {
        logger.error(loggerOptions, `Error inserting data in validator table: ${JSON.stringify(error)}`);
      }
    }

    // Log validator execution time
    const validatorEndTime = new Date().getTime();
    logger.info(loggerOptions, `Stored validator staking info in ${((validatorEndTime - startTime) / 1000).toFixed(3)}s`);
  }
}
