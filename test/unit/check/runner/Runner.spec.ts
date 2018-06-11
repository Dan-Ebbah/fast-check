import * as assert from 'assert';
import * as fc from '../../../../lib/fast-check';

import Shrinkable from '../../../../src/check/arbitrary/definition/Shrinkable';
import { char } from '../../../../src/check/arbitrary/CharacterArbitrary';
import IProperty from '../../../../src/check/property/IProperty';
import { check, assert as rAssert } from '../../../../src/check/runner/Runner';
import Random from '../../../../src/random/generator/Random';
import { RunDetails } from '../../../../src/check/runner/reporter/RunDetails';
import { PreconditionFailure } from '../../../../src/check/precondition/PreconditionFailure';
import { stream, Stream } from '../../../../src/stream/Stream';

const MAX_NUM_RUNS = 1000;
describe('Runner', () => {
  describe('check', () => {
    it('Should throw if property is null', () => assert.throws(() => check((null as any) as IProperty<{}>)));
    it('Should throw if property is not a property at all', () => assert.throws(() => check(<IProperty<{}>>{})));
    it('Should throw if property is an Arbitrary', () => assert.throws(() => check(<IProperty<{}>>(<any>char()))));
    it('Should call the property 100 times by default (on success)', () => {
      let num_calls_generate = 0;
      let num_calls_run = 0;
      const p: IProperty<[number]> = {
        isAsync: () => false,
        generate: () => {
          assert.equal(num_calls_run, num_calls_generate, 'Should have called run before calling back');
          ++num_calls_generate;
          return new Shrinkable([num_calls_generate]) as Shrinkable<[number]>;
        },
        run: (value: [number]) => {
          assert.equal(value[0], num_calls_generate, 'Should be called with previously generated value');
          ++num_calls_run;
          return null;
        }
      };
      const out = check(p) as RunDetails<[number]>;
      assert.equal(num_calls_generate, 100, 'Should have called generate 100 times');
      assert.equal(num_calls_run, 100, 'Should have called run 100 times');
      assert.equal(out.failed, false, 'Should not have failed');
    });
    it('Should ignore precondition failure runs and generate another value', async () => {
      const gapsBetweenSuccessesArb = fc.array(fc.nat(10), 100, 100);
      const successfulRunIdsArb = gapsBetweenSuccessesArb.map(gaps =>
        gaps.reduce((prev: number[], cur: number) => {
          prev.push(prev.length === 0 ? cur : prev[prev.length - 1] + cur + 1);
          return prev;
        }, [])
      );
      await fc.assert(
        fc.asyncProperty(
          successfulRunIdsArb,
          fc.boolean(),
          fc.option(fc.nat(99)),
          async (successIds, isAsyncProp, failAtId) => {
            let num_calls_generate = 0;
            let num_calls_run = 0;
            const p: IProperty<[number]> = {
              isAsync: () => isAsyncProp,
              generate: () => new Shrinkable([num_calls_generate++]) as Shrinkable<[number]>,
              run: (value: [number]) => {
                ++num_calls_run;
                const successId = successIds.indexOf(value[0]);
                if (successId !== -1) return successId === failAtId ? 'failed' : null;
                return new PreconditionFailure();
              }
            };
            const out = await check(p);
            if (failAtId == null) {
              const expectedGenerate = successIds[successIds.length - 1] + 1;
              const expectedSkips = expectedGenerate - 100;
              assert.equal(
                num_calls_generate,
                expectedGenerate,
                `Should have called generate ${expectedGenerate} times`
              );
              assert.equal(num_calls_run, expectedGenerate, `Should have called run ${expectedGenerate} times`);
              assert.equal(out.numRuns, 100, 'Should have count 100 runs');
              assert.equal(out.numSkips, expectedSkips, `Should have count ${expectedSkips} skips`);
              assert.equal(out.failed, false, 'Should not have failed');
            } else {
              const expectedGenerate = successIds[failAtId] + 1;
              const expectedSkips = expectedGenerate - failAtId - 1;
              assert.equal(
                num_calls_generate,
                expectedGenerate,
                `Should have called generate ${expectedGenerate} times`
              );
              assert.equal(num_calls_run, expectedGenerate, `Should have called run ${expectedGenerate} times`);
              assert.equal(out.numRuns, failAtId + 1, `Should have count ${failAtId} runs`);
              assert.equal(out.numSkips, expectedSkips, `Should have count ${expectedSkips} skips`);
              assert.equal(out.failed, true, 'Should have failed');
            }
          }
        )
      );
    });
    it('Should never call shrink on success', () => {
      let num_calls_generate = 0;
      let num_calls_run = 0;
      const p: IProperty<[number]> = {
        isAsync: () => false,
        generate: () => {
          ++num_calls_generate;
          return new Shrinkable([0], () => {
            throw 'Not implemented';
          }) as Shrinkable<[number]>;
        },
        run: (value: [number]) => {
          ++num_calls_run;
          return null;
        }
      };
      const out = check(p) as RunDetails<[number]>;
      assert.equal(num_calls_generate, 100, 'Should have called generate 100 times');
      assert.equal(num_calls_run, 100, 'Should have called run 100 times');
      assert.equal(out.failed, false, 'Should not have failed');
    });
    it('Should call the property 100 times by default (except on error)', () =>
      fc.assert(
        fc.property(fc.integer(1, 100), fc.integer(), (num, seed) => {
          let num_calls_generate = 0;
          let num_calls_run = 0;
          const p: IProperty<[number]> = {
            isAsync: () => false,
            generate: () => {
              ++num_calls_generate;
              return new Shrinkable([0]) as Shrinkable<[number]>;
            },
            run: (value: [number]) => {
              return ++num_calls_run < num ? null : 'error';
            }
          };
          const out = check(p, { seed: seed }) as RunDetails<[number]>;
          assert.equal(
            num_calls_generate,
            num,
            `Should have stopped generate at first failing run (run number ${num})`
          );
          assert.equal(
            num_calls_run,
            num,
            `Should have stopped run (because no shrink) at first failing run (run number ${num})`
          );
          assert.ok(out.failed, 'Should have failed');
          assert.equal(out.numRuns, num, `Should have failed after ${num} tests`);
          assert.equal(out.seed, seed, `Should attach the failing seed`);
          return true;
        })
      ));
    it('Should alter the number of runs when asked to', () =>
      fc.assert(
        fc.property(fc.nat(MAX_NUM_RUNS), num => {
          let num_calls_generate = 0;
          let num_calls_run = 0;
          const p: IProperty<[number]> = {
            isAsync: () => false,
            generate: () => {
              ++num_calls_generate;
              return new Shrinkable([0]) as Shrinkable<[number]>;
            },
            run: (value: [number]) => {
              ++num_calls_run;
              return null;
            }
          };
          const out = check(p, { numRuns: num }) as RunDetails<[number]>;
          assert.equal(num_calls_generate, num, `Should have called generate ${num} times`);
          assert.equal(num_calls_run, num, `Should have called run ${num} times`);
          assert.equal(out.failed, false, 'Should not have failed');
          return true;
        })
      ));
    it('Should generate the same values given the same seeds', () =>
      fc.assert(
        fc.property(fc.integer(), seed => {
          const buildPropertyFor = function(runOn: number[]) {
            const p: IProperty<[number]> = {
              isAsync: () => false,
              generate: (rng: Random) => {
                return new Shrinkable([rng.nextInt()]) as Shrinkable<[number]>;
              },
              run: (value: [number]) => {
                runOn.push(value[0]);
                return null;
              }
            };
            return p;
          };
          let data1: number[] = [];
          let data2: number[] = [];
          check(buildPropertyFor(data1), { seed: seed });
          check(buildPropertyFor(data2), { seed: seed });
          assert.deepEqual(data2, data1, 'Should run on the same values given the same seed');
          return true;
        })
      ));
    it('Should not provide list of failures by default (no verbose)', () => {
      const p: IProperty<[number]> = {
        isAsync: () => false,
        generate: () => new Shrinkable([42]) as Shrinkable<[number]>,
        run: () => 'failure'
      };
      const out = check(p) as RunDetails<[number]>;
      assert.ok(out.failures.length === 0);
    });
    it('Should provide the list of failures in verbose mode', () => {
      const g = function*() {
        yield new Shrinkable([48]) as Shrinkable<[number]>;
        yield new Shrinkable([12]) as Shrinkable<[number]>;
      };
      const p: IProperty<[number]> = {
        isAsync: () => false,
        generate: () => new Shrinkable([42], () => stream(g())) as Shrinkable<[number]>,
        run: () => 'failure'
      };
      const out = check(p, { verbose: true }) as RunDetails<[number]>;
      assert.ok(out.failures.length !== 0);
      assert.deepStrictEqual(out.failures, [[42], [48]]);
    });
    it('Should build the right counterexamplePath', () =>
      fc.assert(
        fc.property(fc.integer(), fc.array(fc.nat(99), 1, 100), (seed, failurePoints) => {
          // Each entry (at index idx) in failurePoints represents the number of runs
          // required before failing for the level <idx>
          // Basically it must fail before the end of the execution (100 runs by default)
          // so failure points are between 0 and 99 inclusive

          const deepShrinkable = function(depth: number): Shrinkable<[number]> {
            if (depth <= 0) return new Shrinkable([0]) as Shrinkable<[number]>;
            function* g(subDepth: number): IterableIterator<Shrinkable<[number]>> {
              while (true) yield deepShrinkable(subDepth);
            }
            return new Shrinkable([0], () => stream(g(depth - 1))) as Shrinkable<[number]>;
          };

          let idx = 0;
          let remainingBeforeFailure = failurePoints[idx];
          const p: IProperty<[number]> = {
            isAsync: () => false,
            generate: (rng: Random) => deepShrinkable(failurePoints.length - 1),
            run: (value: [number]) => {
              if (--remainingBeforeFailure >= 0) return null;
              remainingBeforeFailure = failurePoints[++idx];
              return 'failure';
            }
          };
          const expectedFailurePath = failurePoints.join(':');
          const out = check(p, { seed: seed }) as RunDetails<[number]>;
          assert.ok(out.failed);
          assert.equal(out.seed, seed);
          assert.equal(out.numRuns, failurePoints[0] + 1);
          assert.equal(out.numShrinks, failurePoints.length - 1);
          assert.equal(out.counterexamplePath, expectedFailurePath);
        })
      ));
    it('Should wait on async properties to complete', async () =>
      fc.assert(
        fc.asyncProperty(fc.integer(1, 100), fc.integer(), async (num, seed) => {
          const delay = () => new Promise((resolve, reject) => setTimeout(resolve, 0));

          let runnerHasCompleted = false;
          let waitingResolve: (() => void)[] = [];
          let num_calls_generate = 0;
          let num_calls_run = 0;
          const p: IProperty<[number]> = {
            isAsync: () => true,
            generate: () => {
              ++num_calls_generate;
              const shrinkedValue = new Shrinkable([42]) as Shrinkable<[number]>;
              const g = function*() {
                yield shrinkedValue;
              };
              return new Shrinkable([1], () => new Stream(g())) as Shrinkable<[number]>;
            },
            run: async (value: [number]) => {
              await new Promise((resolve, reject) => {
                waitingResolve.push(resolve);
              });
              return ++num_calls_run < num ? null : 'error';
            }
          };
          const checker = check(p, { seed: seed }) as Promise<RunDetails<[number]>>;
          checker.then(() => (runnerHasCompleted = true));

          await delay();
          while (waitingResolve.length > 0) {
            assert.equal(waitingResolve.length, 1, 'Should not run multiple properties in parallel');
            assert.equal(runnerHasCompleted, false, 'Should not have completed yet');
            waitingResolve.shift()!();
            await delay();
          }

          await delay();
          assert.equal(runnerHasCompleted, true, 'Should have completed');

          const out = await checker;
          assert.equal(
            num_calls_generate,
            num,
            `Should have stopped generate at first failing run (run number ${num})`
          );
          assert.equal(
            num_calls_run,
            num + 1,
            `Should have stopped run one shrink after first failing run (run number ${num + 1})`
          );
          assert.ok(out.failed, 'Should have failed');
          assert.equal(out.numRuns, num, `Should have failed after ${num} tests`);
          assert.equal(out.seed, seed, `Should attach the failing seed`);
          assert.deepStrictEqual(
            out.counterexample,
            [42],
            `Should have been shrinked to [42] got ${JSON.stringify(out.counterexample)}`
          );
          return true;
        })
      ));
    it('Should not timeout if no timeout defined', async () => {
      const p: IProperty<[number]> = {
        isAsync: () => true,
        generate: () => new Shrinkable([1]) as Shrinkable<[number]>,
        run: async (value: [number]) => null
      };
      const out = await (check(p) as Promise<RunDetails<[number]>>);
      assert.equal(out.failed, false, 'Should not have failed');
    });
    it('Should not timeout if timeout not reached', async () => {
      const wait = (timeMs: number) => new Promise<null>((resolve, reject) => setTimeout(resolve, timeMs));
      const p: IProperty<[number]> = {
        isAsync: () => true,
        generate: () => new Shrinkable([1]) as Shrinkable<[number]>,
        run: async (value: [number]) => await wait(0)
      };
      const out = await (check(p, { timeout: 100 }) as Promise<RunDetails<[number]>>);
      assert.equal(out.failed, false, 'Should not have failed');
    });
    it('Should timeout if it reached the timeout', async () => {
      const wait = (timeMs: number) => new Promise<null>((resolve, reject) => setTimeout(resolve, timeMs));
      const p: IProperty<[number]> = {
        isAsync: () => true,
        generate: () => new Shrinkable([1]) as Shrinkable<[number]>,
        run: async (value: [number]) => await wait(100)
      };
      const out = await (check(p, { timeout: 0 }) as Promise<RunDetails<[number]>>);
      assert.equal(out.failed, true, 'Should have failed');
    });
    it('Should timeout if task never ends', async () => {
      const neverEnds = () => new Promise<null>((resolve, reject) => {});
      const p: IProperty<[number]> = {
        isAsync: () => true,
        generate: () => new Shrinkable([1]) as Shrinkable<[number]>,
        run: async (value: [number]) => await neverEnds()
      };
      const out = await (check(p, { timeout: 0 }) as Promise<RunDetails<[number]>>);
      assert.equal(out.failed, true, 'Should have failed');
    });
  });
  describe('assert', () => {
    const v1 = { toString: () => 'toString(value#1)' };
    const v2 = { a: 'Hello', b: 21 };
    const failingProperty: IProperty<[any, any]> = {
      isAsync: () => false,
      generate: () => new Shrinkable([v1, v2]) as Shrinkable<[any, any]>,
      run: (v: [any, any]) => 'error in failingProperty'
    };
    const failingComplexProperty: IProperty<[any, any, any]> = {
      isAsync: () => false,
      generate: () => new Shrinkable([[v1, v2], v2, v1]) as Shrinkable<[any, any, any]>,
      run: (v: [any, any, any]) => 'error in failingComplexProperty'
    };
    const successProperty: IProperty<[any, any]> = {
      isAsync: () => false,
      generate: () => new Shrinkable([v1, v2]) as Shrinkable<[any, any]>,
      run: (v: [any, any]) => null
    };

    it('Should throw if property is null', () => assert.throws(() => rAssert((null as any) as IProperty<{}>)));
    it('Should throw if property is not a property at all', () => assert.throws(() => rAssert(<IProperty<{}>>{})));
    it('Should throw if property is an Arbitrary', () => assert.throws(() => rAssert(<IProperty<{}>>(<any>char()))));
    it('Should never throw if no failure occured', () => {
      try {
        rAssert(successProperty, { seed: 42 });
      } catch (err) {
        assert.ok(false, 'No exception expected on success');
      }
    });
    it('Should throw on failure', () => {
      try {
        rAssert(failingProperty, { seed: 42 });
      } catch (err) {
        return;
      }
      assert.ok(false, 'Expected an exception, got success');
    });
    it('Should put the seed in error message', () => {
      try {
        rAssert(failingProperty, { seed: 42 });
      } catch (err) {
        assert.ok(err.message.indexOf(`(seed: 42, path:`) !== -1, `Cannot find the seed in: ${err.message}`);
        return;
      }
      assert.ok(false, 'Expected an exception, got success');
    });
    it('Should put the number of tests in error message', () => {
      try {
        rAssert(failingProperty, { seed: 42 });
      } catch (err) {
        assert.ok(
          err.message.indexOf(`failed after 1 test`) !== -1,
          `Cannot find the number of tests in: ${err.message}`
        );
        return;
      }
      assert.ok(false, 'Expected an exception, got success');
    });
    it('Should pretty print the failing example in error message', () => {
      try {
        rAssert(failingProperty, { seed: 42 });
      } catch (err) {
        assert.ok(
          err.message.indexOf(`[${v1.toString()},${JSON.stringify(v2)}]`) !== -1,
          `Cannot find the example in: ${err.message}`
        );
        return;
      }
      assert.ok(false, 'Expected an exception, got success');
    });
    it('Should pretty print the failing complex example in error message', () => {
      try {
        rAssert(failingComplexProperty, { seed: 42 });
      } catch (err) {
        assert.ok(
          err.message.indexOf(`[[${v1.toString()},${JSON.stringify(v2)}],${JSON.stringify(v2)},${v1.toString()}]`) !==
            -1,
          `Cannot find the example in: ${err.message}`
        );
        return;
      }
      assert.ok(false, 'Expected an exception, got success');
    });
    it('Should put the orginal error in error message', () => {
      try {
        rAssert(failingProperty, { seed: 42 });
      } catch (err) {
        assert.ok(
          err.message.indexOf(`Got error: error in failingProperty`) !== -1,
          `Cannot find the original error in: ${err.message}`
        );
        return;
      }
      assert.ok(false, 'Expected an exception, got success');
    });
    it('Should not provide list of failures by default (no verbose)', () => {
      const p: IProperty<[number]> = {
        isAsync: () => false,
        generate: () => new Shrinkable([42]) as Shrinkable<[number]>,
        run: () => 'failure'
      };
      try {
        rAssert(p);
      } catch (err) {
        assert.ok(err.message.indexOf('Encountered failures were:') === -1);
      }
    });
    it('Should provide the list of failures in verbose mode', () => {
      const g = function*() {
        yield new Shrinkable([48]) as Shrinkable<[number]>;
        yield new Shrinkable([12]) as Shrinkable<[number]>;
      };
      const p: IProperty<[number]> = {
        isAsync: () => false,
        generate: () => new Shrinkable([42], () => stream(g())) as Shrinkable<[number]>,
        run: () => 'failure'
      };
      try {
        rAssert(p, { verbose: true });
      } catch (err) {
        assert.ok(err.message.indexOf('Encountered failures were:\n- [42]\n- [48]') !== -1);
      }
    });
  });
});
