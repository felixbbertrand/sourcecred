// @flow

import fs from "fs-extra";
import stringify from "json-stable-stringify";
import {join as pathJoin} from "path";
import {sum} from "d3-array";

import sortBy from "../util/sortBy";
import {credrank} from "../core/credrank/compute";
import {CredGraph, type Participant} from "../core/credrank/credGraph";
import {LoggingTaskReporter} from "../util/taskReporter";
import {computeBonusMinting, createBonusGraph} from "../core/bonusMinting";
import type {Command} from "./command";
import {loadInstanceConfig, prepareCredData, loadCredGraph} from "./common";
import {merge} from "../core/weightedGraph";
import {type Uuid} from "../util/uuid";

function die(std, message) {
  std.err("fatal: " + message);
  return 1;
}

const credrankCommand: Command = async (args, std) => {
  let shouldIncludeDiff = false;
  const processedArgs = args.filter((arg) => {
    switch (arg) {
      case "-d":
        shouldIncludeDiff = true;
        return false;
      default:
        return true;
    }
  });

  if (processedArgs.length !== 0) {
    return die(std, "usage: sourcecred credrank [-d]");
  }
  const taskReporter = new LoggingTaskReporter();
  taskReporter.start("credrank");

  const baseDir = process.cwd();
  const config = await loadInstanceConfig(baseDir);

  taskReporter.start("load data");
  const {weightedGraph, ledger, dependencies} = await prepareCredData(
    baseDir,
    config
  );
  const bonusGraph = createBonusGraph(
    computeBonusMinting(weightedGraph, dependencies)
  );
  const combinedWeightedGraph = merge([weightedGraph, bonusGraph]);
  taskReporter.finish("load data");

  taskReporter.start("run CredRank");
  const credGraph = await credrank(combinedWeightedGraph, ledger);
  taskReporter.finish("run CredRank");

  if (shouldIncludeDiff) {
    taskReporter.start("load prior graph");
    try {
      const priorCredGraph = await loadCredGraph(baseDir);
      printCredDiffTable(credGraph, priorCredGraph);
    } catch {
      console.log("Could not load existing credGraph.json. Skipping diff.");
      printCredSummaryTable(credGraph);
    }
    taskReporter.finish("load prior graph");
  } else {
    printCredSummaryTable(credGraph);
  }

  taskReporter.start("write cred graph");
  const cgJson = stringify(credGraph.toJSON());
  const outputPath = pathJoin(baseDir, "output", "credGraph.json");
  await fs.writeFile(outputPath, cgJson);
  taskReporter.finish("write cred graph");

  taskReporter.finish("credrank");
  return 0;
};

function printCredSummaryTable(credGraph: CredGraph) {
  console.log(`# Top Participants By Cred`);
  console.log();
  console.log(`| Description | Cred | % |`);
  console.log(`| --- | --- | --- |`);
  const credParticipants = Array.from(credGraph.participants());
  const sortedParticipants = sortBy(credParticipants, (p) => -p.cred);
  const totalCred = sum(sortedParticipants, (p) => p.cred);
  function row({cred, description}) {
    const percentage = (100 * cred) / totalCred;
    return `| ${description} | ${cred.toFixed(1)} | ${percentage.toFixed(
      1
    )}% |`;
  }
  sortedParticipants.slice(0, 20).forEach((n) => console.log(row(n)));
}

function printCredDiffTable(credGraph: CredGraph, priorCredGraph: CredGraph) {
  console.log(`# Top Participants By New Cred`);
  const priorParticipants: Map<Uuid, Participant> = new Map();
  for (const participant of priorCredGraph.participants())
    priorParticipants.set(participant.id, participant);

  const credParticipants = Array.from(credGraph.participants());
  const sortedParticipants = sortBy(credParticipants, (p) => -p.cred);
  function row({cred, description, id}) {
    const prior = priorParticipants.get(id);
    if (!prior)
      throw `Participant [${description}, ${id}] exists in the new scores but not in the old. Rerun without -d to refresh.`;
    const percentageChange = (100 * (cred - prior.cred)) / prior.cred;
    const percentageChangeStr =
      percentageChange > 10000
        ? ">10,000%"
        : `${percentageChange > 0 ? "+" : ""}${percentageChange.toFixed(1)}%`;
    return {
      "Name": description,
      "Prior Cred": prior.cred.toFixed(1),
      "New Cred": cred.toFixed(1),
      "% Change": percentageChangeStr,
    };
  }
  type Row = {
    "Name": string,
    "Prior Cred": string,
    "New Cred": string,
    "% Change": string,
  };
  const rows: Array<Row> = sortedParticipants.slice(0, 20).map((n) => row(n));
  console.table(rows);
}

export default credrankCommand;
