'use client';

import { useState } from 'react';
import type { SetupStep, GrantedScope } from '@salvations/catalog';
import { Icon } from '@/components/ui';

/**
 * A numbered setup walkthrough.
 *
 * Every step somebody performs in somebody else's app is a step they can get
 * wrong silently, so each one gets a number, a sentence and — where it matters
 * — the exact string to type. A link always opens in a new tab: losing a
 * half-filled setup form to a navigation is how people end up doing this twice.
 */
export function SetupSteps({ steps }: { steps: readonly SetupStep[] }) {
  return (
    <ol className="steps">
      {steps.map((step, index) => (
        <li key={step.title}>
          <span className="steps-num" aria-hidden>{index + 1}</span>
          <div>
            <strong>{step.title}</strong>
            <p>{step.body}</p>
            {step.literal !== undefined && <Copyable value={step.literal} />}
            {step.link !== undefined && (
              <a
                className="steps-link"
                href={step.link.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                {step.link.label} <Icon name="arrow" size={13} />
              </a>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * Something to be typed somewhere else, verbatim.
 *
 * Copying is offered and never assumed: the clipboard API is refused outright
 * in some browsers and in any insecure context, so the value stays selectable
 * text and the button is an accelerator rather than the only way through.
 */
export function Copyable({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="copyable">
      {label !== undefined && <span className="copyable-label">{label}</span>}
      <code>{value}</code>
      <button
        type="button"
        className="ghost"
        aria-label={`Copy ${label ?? 'value'}`}
        onClick={() => {
          navigator.clipboard?.writeText(value)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            })
            .catch(() => undefined);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/**
 * What connecting grants.
 *
 * Anything that can change or destroy something is marked, because "read your
 * mail" and "read, send and modify your mail" are the same length on screen and
 * are not remotely the same decision.
 */
export function ScopeList({ scopes }: { scopes: readonly GrantedScope[] }) {
  return (
    <ul className="scopes">
      {scopes.map((scope) => (
        <li key={scope.scope}>
          <Icon name={scope.writes ? 'shield' : 'check'} size={15} />
          <span>
            {scope.label}
            {scope.writes && <span className="badge warn" style={{ marginLeft: 8 }}>can change things</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
