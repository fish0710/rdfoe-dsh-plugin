/**
 * PH SDD artifact templates (project-harness runtime/templates/sdd), copied
 * into the plugin and bundled as text. References to ph_sdd.py were rewritten
 * to the workflow's own state; everything else is the upstream wording.
 * Node prompts append the template of each file the node must write.
 */
import acceptance from './templates/acceptance-template.md'
import change from './templates/change-template.md'
import design from './templates/design-template.md'
import requirement from './templates/requirement-template.md'
import review from './templates/review-template.md'
import tasks from './templates/tasks-template.md'
import verification from './templates/verification-template.md'
import verifyPlan from './templates/verify-plan-template.md'

/** Artifact file name → its template text. */
export const PH_TEMPLATES: Readonly<Record<string, string>> = {
  'requirement.md': requirement,
  'design.md': design,
  'review.md': review,
  'tasks.md': tasks,
  'verify-plan.md': verifyPlan,
  'acceptance.md': acceptance,
  'verification.md': verification,
  'change.md': change,
}
