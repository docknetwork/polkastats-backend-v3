// @ts-check
const { BigNumber } = require('bignumber.js');
const { getDisplayName } = require('../utils.js');
const pino = require('pino');
const logger = pino();

const loggerOptions = {
  crawler: `poa-validators`
};

const hardcodedAddresses = {
	"5DVcdiH9cs5RGcrzDw15d972Jfkt3ATWr4fsMEaGfq44azNy": "NOVY",
	"5DeYZhoygS7GVhxUPcCcmLkRND3CFeeuUhfTx9EdNXMCboZH": "pathrock",
	"5FsGraZQvF2gUN5ZwRgcFnp9Q9k9FbVF5nPANXvmkN7kkv3Z": "Ryabina",
	"5EgUQVUKdKFP7tpcZmK3K2gMtCVyTymmYiXzGNqU53bLQHVb": "QUBITVISION",
	"5DjPH6m1x4QLc4YaaxtVX752nQWZzBHZzwNhn5TztyMDgz8t": "V1T1",
	"5HR2ytqigzQdbthhWA2g5K9JQayczEPwhAfSqAwSyb8Etmqh": "V1T2",
	"5DsDPaYqY5NDNsAmstaMvg9mSbh9xrZyi8muRD96fc5csqna": "sebytza05",
	"5CjJzXj9wRsj4myY6eQNRuDsc7ybcWU5XgwKfkG6p2wZ491V": "Perfect Stake",
	"5Ex2HZEk7pAnGbgqYkux6vrdbrrYhPc8Z7JyFYeqtYxqUZN7": "Art555",
	"5CE28qDvZPGxdtdKbJ6U6UdRUDSVuYHPUypCpAGoarB8HkzU": "Alive29",
	"5ChYCbuttVS9jE6RnPZUMkeSSkgJpfT5S2LffCqNu5NdhrjB": "InvestIQ"
};

// TODO: perhaps we can cache and pull this periodically, for now just hardcoded above
// const addressUri = '//gist.githubusercontent.com/lovesh/c540b975774735fe0001c86fa47a91b3/raw/0a1ae15962372095348669995d58a2bd0c0bc737/validator%2520names';
// function getDefaultContacts (): null {
//   axios.get(addressUri)
//     .then(function (response): null {
//       hardcodedAddresses = response.data;
//     });
// }

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
