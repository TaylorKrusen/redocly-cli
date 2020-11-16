#!/usr/bin/env node

import * as yargs from 'yargs';
import { extname, basename, dirname, join } from 'path';
import { green, yellow, blue, gray } from 'colorette';
import { performance } from 'perf_hooks';
import { Totals } from './types';
import {
  BundleOutputFormat,
  validate,
  bundle,
  loadConfig,
  LintConfig,
  RedoclyClient,
  formatProblems,
  OutputFormat,
} from "@redocly/openapi-core";

import {
  getFallbackEntryPointsOrExit,
  getExecutionTime,
  getTotals,
  dumpBundle,
  saveBundle,
  promptUser,
  pluralize,
  printLintTotals,
  handleError
} from './utils';
import { previewDocs } from './commands/preview-docs';
import { handleStats } from './commands/stats';
import { handleSplit } from './commands/split';
import { handleJoin } from './commands/join';
const version = require('../package.json').version;
const outputExtensions = ['json', 'yaml', 'yml'] as ReadonlyArray<BundleOutputFormat>;

yargs
  .version('version', 'Show version number.', version)
  .help('help', 'Show help.')
  .command('stats [entrypoint]', 'Gathering statistics for a document',
    (yargs) => yargs
      .positional('entrypoint', { type: 'string' })
      .option({
          config: { description: 'Specify path to the config file.', type: 'string' },
          format: {
            description: 'Use a specific output format.',
            choices: ['stylish', 'json'] as ReadonlyArray<OutputFormat>,
            default: 'stylish' as OutputFormat,
          }
        }
      ),
    async (argv) => { handleStats(argv) }
  )
  .command('split [entrypoint]', 'Split definition into a multi-file structure',
    (yargs) => yargs
      .positional('entrypoint', { type: 'string' })
      .option({ outDir: {
          description: 'Output directory where files will be saved',
          required: true,
          type: 'string'
        }}),
    (argv) => { handleSplit(argv) }
  )
  .command('join [entrypoints...]', 'Join definitions [experimental]',
    (yargs) => yargs
      .positional('entrypoints', {
        array: true,
        type: 'string',
        demandOption: true
      })
      .option({
        lint: { description: 'Lint definitions', type: 'boolean', default: false },
        'prefix-tags-with-info-prop': {
          description: 'Prefix tags with property value from info object',
          requiresArg: true,
          type: 'string',
        },
        'prefix-tags-with-filename': {
          description: 'Prefix tags with property value from file name',
          type: 'boolean',
          default: false
        },
        'prefix-components-with-info-prop': {
          description: 'Prefix components with property value from info object',
          requiresArg: true,
          type: 'string',
        }
      }),
    (argv) => { handleJoin(argv, version) }
  )
  .command(
    'lint [entrypoints...]',
    'Lint definition.',
    (yargs) =>
      yargs
        .positional('entrypoints', {
          array: true,
          type: 'string',
          demandOption: true,
        })
        .option('format', {
          description: 'Use a specific output format.',
          choices: ['stylish', 'codeframe', 'json'] as ReadonlyArray<OutputFormat>,
          default: 'codeframe' as OutputFormat,
        })
        .option('max-problems', {
          requiresArg: true,
          description: 'Reduce output to max N problems.',
          type: 'number',
          default: 100,
        })
        .option('generate-ignore-file', {
          description: 'Generate ignore file.',
          type: 'boolean',
        })
        .option('skip-rule', {
          description: 'Ignore certain rules.',
          array: true,
          type: 'string',
        })
        .option('skip-preprocessor', {
          description: 'Ignore certain preprocessors.',
          array: true,
          type: 'string',
        })
        .option('config', {
          description: 'Specify path to the config file.',
          requiresArg: true,
          type: 'string',
        })
        .option('extends', {
          description: 'Override extends configurations (defaults or config file settings).',
          requiresArg: true,
          array: true,
          type: 'string',
        }),
    async (argv) => {
      const config = await loadConfig(argv.config, argv.extends);
      config.lint.skipRules(argv['skip-rule']);
      config.lint.skipPreprocessors(argv['skip-preprocessor']);

      const entrypoints = await getFallbackEntryPointsOrExit(argv.entrypoints, config);

      if (argv['generate-ignore-file']) {
        config.lint.ignore = {}; // clear ignore
      }

      const totals: Totals = { errors: 0, warnings: 0, ignored: 0 };
      let totalIgnored = 0;

      if (config.lint.recommendedFallback) {
        process.stderr.write(
          `No configurations were defined in extends -- using built in ${blue('recommended')} configuration by default.\n\n`,
        );
      }

      // TODO: use shared externalRef resolver, blocked by preprocessors now as they can mutate documents
      for (const entryPoint of entrypoints) {
        try {
          const startedAt = performance.now();
          process.stderr.write(gray(`validating ${entryPoint}...\n`));
          const results = await validate({
            ref: entryPoint,
            config,
          });

          const fileTotals = getTotals(results);
          totals.errors += fileTotals.errors;
          totals.warnings += fileTotals.warnings;
          totals.ignored += fileTotals.ignored;

          if (argv['generate-ignore-file']) {
            for (let m of results) {
              config.lint.addIgnore(m);
              totalIgnored++;
            }
          } else {
            formatProblems(results, {
              format: argv.format,
              maxProblems: argv['max-problems'],
              totals: fileTotals,
              version
            });
          }

          const elapsed = getExecutionTime(startedAt);
          process.stderr.write(gray(`${entryPoint}: validated in ${elapsed}\n\n`));
        } catch (e) {
          totals.errors++;
          handleError(e, entryPoint);
        }
      }

      if (argv['generate-ignore-file']) {
        config.lint.saveIgnore();
        process.stderr.write(
          `Generated ignore file with ${totalIgnored} ${pluralize('problem', totalIgnored)}.\n\n`,
        );
      } else {
        printLintTotals(totals, entrypoints.length);
      }

      printUnusedWarnings(config.lint);
      process.exit(totals.errors === 0 || argv['generate-ignore-file'] ? 0 : 1);
    },
  )
  .command(
    'bundle [entrypoints...]',
    'Bundle definition.',
    (yargs) =>
      yargs
        .positional('entrypoints', {
          array: true,
          type: 'string',
          demandOption: true,
        })
        .options({
          output: { type: 'string', alias: 'o' },
        })
        .option('format', {
          description: 'Use a specific output format.',
          choices: ['stylish', 'codeframe', 'json'] as ReadonlyArray<OutputFormat>,
          default: 'codeframe' as OutputFormat,
        })
        .option('max-problems', {
          requiresArg: true,
          description: 'Reduce output to max N problems.',
          type: 'number',
          default: 100,
        })
        .option('ext', {
          description: 'Bundle file extension.',
          requiresArg: true,
          choices: outputExtensions,
        })
        .option('skip-rule', {
          description: 'Ignore certain rules.',
          array: true,
          type: 'string',
        })
        .option('skip-preprocessor', {
          description: 'Ignore certain preprocessors.',
          array: true,
          type: 'string',
        })
        .option('skip-decorator', {
          description: 'Ignore certain decorators.',
          array: true,
          type: 'string',
        })
        .option('dereferenced', {
          alias: 'd',
          type: 'boolean',
          description: 'Produce fully dereferenced bundle.',
        })
        .option('force', {
          alias: 'f',
          type: 'boolean',
          description: 'Produce bundle output even when errors occur.',
        })
        .option('config', {
          description: 'Specify path to the config file.',
          type: 'string',
        }),
    async (argv) => {
      const config = await loadConfig(argv.config);
      config.lint.skipRules(argv['skip-rule']);
      config.lint.skipPreprocessors(argv['skip-preprocessor']);
      config.lint.skipDecorators(argv['skip-decorator']);

      const entrypoints = await getFallbackEntryPointsOrExit(argv.entrypoints, config);

      const totals: Totals = { errors: 0, warnings: 0, ignored: 0 };
      for (const entrypoint of entrypoints) {
        try {
          const startedAt = performance.now();
          process.stderr.write(gray(`bundling ${entrypoint}...\n`));
          const { bundle: result, problems } = await bundle({
            config,
            ref: entrypoint,
            dereference: argv.dereferenced,
          });

          const fileTotals = getTotals(problems);

          const { outputFile, ext } = getOutputFileName(
            entrypoint,
            entrypoints.length,
            argv.output,
            argv.ext,
          );

          if (fileTotals.errors === 0 || argv.force) {
            if (!argv.output) {
              const output = dumpBundle(result, argv.ext || 'yaml', argv.dereferenced);
              process.stdout.write(output);
            } else {
              const output = dumpBundle(result, ext, argv.dereferenced);
              saveBundle(outputFile, output);
            }
          }

          totals.errors += fileTotals.errors;
          totals.warnings += fileTotals.warnings;
          totals.ignored += fileTotals.ignored;

          formatProblems(problems, {
            format: argv.format,
            maxProblems: argv['max-problems'],
            totals: fileTotals,
            version,
          });

          const elapsed = getExecutionTime(startedAt);
          if (fileTotals.errors > 0) {
            if (argv.force) {
              process.stderr.write(
                `❓ Created a bundle for ${blue(entrypoint)} at ${blue(
                  outputFile,
                )} with errors ${green(elapsed)}.\n${yellow(
                  'Errors ignored because of --force',
                )}.\n`,
              );
            } else {
              process.stderr.write(
                `❌ Errors encountered while bundling ${blue(
                  entrypoint,
                )}: bundle not created (use --force to ignore errors).\n`,
              );
            }
          } else {
            process.stderr.write(
              `📦 Created a bundle for ${blue(entrypoint)} at ${blue(outputFile)} ${green(
                elapsed,
              )}.\n`,
            );
          }
        } catch (e) {
          handleError(e, entrypoint);
        }
      }

      printUnusedWarnings(config.lint);
      process.exit(totals.errors === 0 || argv.force ? 0 : 1);
    },
  )
  .command('login', 'Login to the Redoc.ly API registry with an access token.', async () => {
    const clientToken = await promptUser(
      green(
        `\n  🔑 Copy your access token from ${blue(
          `https://app.${process.env.REDOCLY_DOMAIN || 'redoc.ly'}/profile`,
        )} and paste it below`,
      ),
    );
    const client = new RedoclyClient();
    client.login(clientToken);
  })
  .command('logout', 'Clear your stored credentials for the Redoc.ly API registry.', async () => {
    const client = new RedoclyClient();
    client.logout();
  })
  .command(
    'preview-docs [entrypoint]',
    'Preview API reference docs for the specified definition.',
    (yargs) =>
      yargs
        .positional('entrypoint', {
          type: 'string',
        })
        .option('port', {
          alias: 'p',
          type: 'number',
          default: 8080,
          description: 'Preview port.',
        })
        .option('skip-preprocessor', {
          description: 'Ignore certain preprocessors.',
          array: true,
          type: 'string',
        })
        .option('skip-decorator', {
          description: 'Ignore certain decorators.',
          array: true,
          type: 'string',
        })
        .option('use-community-edition', {
          description: 'Force using Redoc CE for docs preview.',
          type: 'boolean',
        })
        .option('force', {
          alias: 'f',
          type: 'boolean',
          description: 'Produce bundle output even when errors occur.',
        })
        .option('config', {
          description: 'Specify path to the config file.',
          type: 'string',
        }),
    async (argv) => {
      previewDocs(argv);
    },
  )
  .demandCommand(1)
  .strict().argv;

function getOutputFileName(
  entrypoint: string,
  entries: number,
  output?: string,
  ext?: BundleOutputFormat,
) {
  if (!output) {
    return { outputFile: 'stdout', ext: ext || 'yaml' };
  }

  let outputFile = output;
  if (entries > 1) {
    ext = ext || (extname(entrypoint).substring(1) as BundleOutputFormat);
    if (!outputExtensions.includes(ext as any)) {
      throw new Error(`Invalid file extension: ${ext}.`);
    }
    outputFile = join(output, basename(entrypoint, extname(entrypoint))) + '.' + ext;
  } else {
    if (output) {
      ext = ext || (extname(output).substring(1) as BundleOutputFormat);
    }
    ext = ext || (extname(entrypoint).substring(1) as BundleOutputFormat);
    if (!outputExtensions.includes(ext as any)) {
      throw new Error(`Invalid file extension: ${ext}.`);
    }
    outputFile = join(dirname(outputFile), basename(outputFile, extname(outputFile))) + '.' + ext;
  }
  return { outputFile, ext };
}

function printUnusedWarnings(config: LintConfig) {
  const { preprocessors, rules, decorators } = config.getUnusedRules();
  if (rules.length) {
    process.stderr.write(
      yellow(
        `[WARNING] Unused rules found in ${blue(config.configFile || '')}: ${rules.join(', ')}.\n`,
      ),
    );
  }
  if (preprocessors.length) {
    process.stderr.write(
      yellow(
        `[WARNING] Unused preprocessors found in ${blue(
          config.configFile || '',
        )}: ${preprocessors.join(', ')}.\n`,
      ),
    );
  }
  if (decorators.length) {
    process.stderr.write(
      yellow(
        `[WARNING] Unused decorators found in ${blue(config.configFile || '')}: ${decorators.join(
          ', ',
        )}.\n`,
      ),
    );
  }

  if (rules.length || preprocessors.length) {
    process.stderr.write(`Check the spelling and verify you added plugin prefix.\n`);
  }
}