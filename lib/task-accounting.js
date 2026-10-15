/** Pure task outcome calculation; all counts are per task, not per run. */
export function computeTaskOutcome(task, result, maxAttempts) {
  const insertedThisAttempt = Math.max(0, Number(result?.count || 0));
  const attemptsUsed = Math.max(0, Number(task?.retry_count || 0));
  const complete = Boolean(result?.success) && !Boolean(result?.isPartial);
  const retryable = !complete && attemptsUsed < maxAttempts;
  const taskStatus = complete ? 'done' : (retryable ? 'pending' : 'failed');
  const chapterStatus = taskStatus === 'done' ? 'done' : (retryable ? 'in_progress' : 'failed');
  const cumulativeGenerated = Math.max(0, Number(task?.generated_count || 0)) + insertedThisAttempt;
  const errorText = taskStatus === 'done'
    ? null
    : String(result?.error || result?.message || (result?.isPartial ? 'Partial insert; retry scheduled' : 'Generation failed')).slice(0, 1000);

  return { insertedThisAttempt, attemptsUsed, complete, retryable, taskStatus, chapterStatus, cumulativeGenerated, errorText };
}
