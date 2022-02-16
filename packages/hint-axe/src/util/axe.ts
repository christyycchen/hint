import { CheckResult, AxeResults, ImpactValue, NodeResult as AxeNodeResult } from 'axe-core';

import { HTMLDocument, HTMLElement } from '@hint/utils-dom';
import { readFileAsync } from '@hint/utils-fs';
import { CanEvaluateScript } from 'hint/dist/src/lib/types';
import { HintContext } from 'hint/dist/src/lib/hint-context';
import { Severity } from '@hint/utils-types';

import { getMessage } from '../i18n.import';

const axeCorePromise = readFileAsync(require.resolve('axe-core'));

type EngineKey = object;

type Options = {
    [ruleId: string]: keyof typeof Severity;
} | string[];

type Registration = {
    context: HintContext;
    enabledRules: string[];
    options: { [ruleId: string]: keyof typeof Severity };
    event: CanEvaluateScript;
};

type RegistrationMap = Map<EngineKey, Map<string, Registration[]>>;

/**
 * Accumulates registrations via 'can-evaluate::script' until 'scan::end'.
 * Groups registrations by unique engine key, then by resource URL.
 * Ensures only registrations for the same resource in the same scan are
 * processed together in a single execution of `axe-core`.
 */
const registrationMap: RegistrationMap = new Map();

const getElement = (context: HintContext, node: AxeNodeResult): HTMLElement | undefined | null => {
    let selector = node.target[0];

    // Contrary to types, axe-core can return an array of strings. Take the first.
    if (Array.isArray(selector)) {
        selector = selector[0];
    }

    return context.pageDOM?.querySelector(selector);
};

/** Validate if an axe check result has data associated with it. */
const hasCheckData = (result: CheckResult): boolean => {
    return !!result.data;
};

/** Retrieve the message from an axe check result. */
const toCheckMessage = (result: CheckResult): string => {
    return result.message;
};

/**
 * Combine only the node sub-check results containing data to
 * create a summary. This avoids including sub-check messages
 * stating static facts which are typically redundant with the
 * help text for a rule.
 *
 * E.g. color contrast includes specific data about the calculated
 * contrast value whereas checking for the lang on <html> just
 * restates that the lang attribute was not found.
 */
const getSummary = (node: AxeNodeResult): string => {
    const summary = [...node.all, ...node.any, ...node.none]
        .filter(hasCheckData)
        .map(toCheckMessage)
        .join(' ');

    return summary;
};

/**
 * Save a registration to process in a batched call to `axe-core` later.
 */
const queueRegistration = (registration: Registration, map: RegistrationMap) => {
    const engineKey = registration.context.engineKey;
    const resource = registration.event.resource;
    const registrationsByResource = map.get(engineKey) || new Map();
    const registrations = registrationsByResource.get(resource) || [];

    registrations.push(registration);
    registrationsByResource.set(resource, registrations);
    map.set(engineKey, registrationsByResource);
};

/**
 * Retrieve the registrations for a particular engine instance and resource.
 * Removes returned registrations from the map as they are no longer needed.
 */
const useRegistrations = (engineKey: EngineKey, resource: string, map: RegistrationMap) => {
    const registrationsByResource = map.get(engineKey);

    if (!registrationsByResource) {
        return null;
    }

    const registrations = registrationsByResource.get(resource);

    if (!registrations) {
        return null;
    }

    registrationsByResource.delete(resource);

    if (!registrationsByResource.size) {
        map.delete(engineKey);
    }

    return registrations;
};

/* istanbul ignore next */
const toSeverity = (impact?: ImpactValue) => {
    if (impact === 'minor') {
        return Severity.hint;
    }

    if (impact === 'moderate' || impact === 'serious') {
        return Severity.warning;
    }

    if (impact === 'critical') {
        return Severity.error;
    }

    // In case axe adds a new `impact` that is not tracked above
    return Severity.warning;
};

const withQuotes = (ruleId: string) => {
    return `'${ruleId}'`;
};

const run = async (context: HintContext, event: CanEvaluateScript, rules: string[]): Promise<AxeResults | null> => {
    const axeCoreSource = await axeCorePromise;
    const { document, resource } = event;

    /* istanbul ignore next */
    try {
        const target = document.isFragment ?
            'document.body' :
            'document';

        return await context.evaluate(`(function() {
            ${axeCoreSource}
            var target = ${target};
            return window.axe.run(target, {
                runOnly: {
                    type: 'rule',
                    values: [${rules.map(withQuotes).join(',')}]
                }
            });
        })()`);
    } catch (e) {

        const err = e as Error;
        let message: string;

        if (err.message.includes('evaluation exceeded')) {
            message = getMessage('notFastEnough', context.language);
        } else {
            message = getMessage('errorExecuting', context.language, err.message);
        }

        message = getMessage('tryAgainLater', context.language, message);

        context.report(resource, message, { severity: Severity.warning });

        return null;
    }
};

const normalizeOptions = (options: Options) => {
    if (Array.isArray(options)) {
        const normalizedOptions = options.reduce((newOptions, axeRuleId) => {
            (newOptions as any)[axeRuleId] = 'default';

            return newOptions;
        }, {});

        return normalizedOptions;
    }

    return options || {};
};

/**
 * Register a given set of axe rules to be queued for evaluation on
 * `can-evaluate::script`. These rules will be aggregated across axe
 * sub-hints and executed in a single batch for a given resource on
 * `scan::end` (for performance). Results will then be split out and
 * reported back via their original context.
 */
export const register = (context: HintContext, rules: string[], disabled: string[]) => {
    const options = normalizeOptions(context.hintOptions);

    const { engineKey } = context;

    const enabledRules = rules.filter((rule) => {
        if (options[rule]) {
            return options[rule] !== 'off';
        }

        return !disabled.includes(rule);
    });

    context.on('can-evaluate::script', (event) => {
        queueRegistration({ context, enabledRules, event, options }, registrationMap);
    });

    context.on('scan::end', async ({ resource }) => {
        const registrations = useRegistrations(engineKey, resource, registrationMap);

        if (!registrations) {
            return;
        }

        // TS doesn't detect we are assigning during `reduce`
        let document!: HTMLDocument;

        const ruleToRegistration = registrations.reduce((map, registration) => {

            // `document` should be the same for all registrations of the same `resource`.
            document = document || registration.event.document;

            registration.enabledRules.forEach((rule) => {
                map.set(rule, registration);
            });

            return map;
        }, new Map<string, Registration>());

        const rules = Array.from(ruleToRegistration.keys());
        const result = await run(context, { document, resource }, rules);

        /* istanbul ignore next */
        if (!result || !Array.isArray(result.violations)) {
            throw new Error(`Unable to parse axe results ${result}`);
        }

        for (const violation of result.violations) {
            for (const node of violation.nodes) {
                const summary = getSummary(node);
                const message = summary ? `${violation.help}: ${summary}` : violation.help;
                const registration = ruleToRegistration.get(violation.id)!;
                const element = getElement(context, node);
                const severity = Severity[registration.options[violation.id]] === Severity.default ?
                    toSeverity(violation.impact) :
                    Severity[registration.options[violation.id]];

                registration.context.report(resource, message, {
                    documentation: [{
                        link: violation.helpUrl,
                        text: getMessage('learnMore', context.language)
                    }],
                    element,
                    severity
                });
            }
        }
    });
};
