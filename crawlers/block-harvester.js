// @ts-check
// Required imports
const { ApiPromise, WsProvider } = require('@polkadot/api');

// Postgres lib
const { Pool, Client } = require('pg');

// Import config params
const {
  wsProviderUrl,
  postgresConnParams
} = require('../backend.config');

async function main () {

  // Start execution
  const startTime = new Date().getTime();

  // Database connection
  const pool = new Pool(postgresConnParams);

  // Get gaps from block table
  let sqlSelect = `
    SELECT
      gap_start, gap_end FROM (
        SELECT block_number + 1 AS gap_start,
        next_nr - 1 AS gap_end
        FROM (
          SELECT block_number, lead(block_number) OVER (ORDER BY block_number) AS next_nr
          FROM block
        ) nr
        WHERE nr.block_number + 1 <> nr.next_nr
      ) AS g
    UNION ALL (
      SELECT
        0 AS gap_start,
        block_number AS gap_end
      FROM
        block
      ORDER BY
        block_number
      ASC LIMIT 1
    )
    ORDER BY gap_start`;
  const res = await pool.query(sqlSelect);

  for (let i = 0; i < res.rows.length; i++) {
    console.log(`Detected gap! harvesting from #${res.rows[i].gap_start} to #${res.rows[i].gap_end}`);
    await harvestBlocks(res.rows[i].gap_start, res.rows[i].gap_end);
  }

  await pool.end();

  // Execution end time
  const endTime = new Date().getTime();

  // 
  // Log execution time
  //
  console.log(`Execution time: ${((endTime - startTime) / 1000).toFixed(0)}s`);
}

async function getBlockEvents(blockHash) {
  const provider = new WsProvider(wsProviderUrl);
  const api = await ApiPromise.create({ provider });
  const events = await api.query.system.events.at(blockHash);
  provider.disconnect();
  return events;
}

async function harvestBlocks(startBlock, endBlock) {

  // Initialise the provider to connect to the local polkadot node
  const provider = new WsProvider(wsProviderUrl);

  // Create the API and wait until ready
  const api = await ApiPromise.create({ provider });

  // Database connection
  const pool = new Pool(postgresConnParams);

  while (startBlock < endBlock) {

    // Get block hash
    const blockHash = await api.rpc.chain.getBlockHash(startBlock);

    // Get extended block header
    const extendedHeader = await api.derive.chain.getHeader(blockHash);
    // console.log(JSON.stringify(extendedHeader, null, 2));

    // Get block parent hash
    const parentHash = extendedHeader.parentHash;
    
    // Get block extrinsics root
    const extrinsicsRoot = extendedHeader.extrinsicsRoot;

    // Get block state root
    const stateRoot = extendedHeader.stateRoot;

    // Get block events
    const blockEvents = getBlockEvents(blockHash);

    // // Loop through the Vec<EventRecord>
    // blockEvents.forEach( async (record, index) => {
    //   // Extract the phase and event
    //   const { event, phase } = record;
    //   // Output event data
    //   console.log(`index: ${index}, section: ${event.section}, method: ${event.method}, phase: ${phase.toString()}, documentation: ${event.meta.documentation.toString()}, data: ${JSON.stringify(event.data)}`);
    // });

    // Get session info for the block
    const currentIndex = await api.query.session.currentIndex.at(blockHash);
    const currentSlot = await api.query.babe.currentSlot.at(blockHash);
    const epochIndex = await api.query.babe.epochIndex.at(blockHash);
    const genesisSlot = await api.query.babe.genesisSlot.at(blockHash);
    const currentEraStartSessionIndex = await api.query.staking.currentEraStartSessionIndex.at(blockHash);

    const epochDuration = api.consts.babe.epochDuration;
    const sessionsPerEra = api.consts.staking.sessionsPerEra;
    const eraLength = epochDuration.mul(sessionsPerEra);

    const epochStartSlot = epochIndex.mul(epochDuration).add(genesisSlot);
    const sessionProgress = currentSlot.sub(epochStartSlot);
    const eraProgress = currentIndex.sub(currentEraStartSessionIndex).mul(epochDuration).add(sessionProgress);
    
    const sessionInfo = {
      currentIndex,
      currentSlot,
      epochIndex,
      genesisSlot,
      currentEraStartSessionIndex,
      epochDuration,
      sessionsPerEra,
      eraLength: eraLength.toString(10),
      epochStartSlot,
      sessionProgress: sessionProgress.toString(10),
      eraProgress: eraProgress.toString(10),
    };
    console.log(JSON.stringify(sessionInfo, null, 2));

    //
    //     TODO:
    //
    //   * Get timestamp from block
    //   * Get session info at block
    //   * Get total issuance at block
    //
    console.log(`PolkaStats v3 - Harvesting block #${startBlock}`);
    const timestamp = new Date().getTime();
    const sqlInsert =
      `INSERT INTO block (
        block_number,
        block_finalized,
        block_author,
        block_hash,
        parent_hash,
        extrinsics_root,
        state_root,
        total_issuance,
        current_era,
        current_index,
        era_length,
        era_progress,
        is_epoch,
        session_length,
        session_per_era,
        session_progress,
        validator_count,
        timestamp
      ) VALUES (
        '${startBlock}',
        '${startBlock}',
        '${extendedHeader.author}',
        '${blockHash}',
        '${parentHash}',
        '${extrinsicsRoot}',
        '${stateRoot}',
        '0',
        '0',
        '0',
        '0',
        '0',
        'true',
        '0',
        '0',
        '0',
        '0',
        '${timestamp}'
      )`;
    const res = await pool.query(sqlInsert);
    startBlock++;
  }
  await pool.end();
  provider.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(-1);
});

