import { bench, blackbox, SamplingType } from ".";
import { computeGrowthFactor } from "./util";

// bench("zero time", () => {})

let arr = "a".repeat(10).split("");
bench("Zero Time", () => {})
bench("this is a benchmark", () => {
    arr.toString();
}, SamplingType.Dynamic);