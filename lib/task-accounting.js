/** Pure task outcome calculation; all counts are per task, not per run. */
export function computeTaskOutcome(task, result, maxAttempts) {
  const insertedThisAttempt = Math.max(0, Number(result?.count || 0));
  const attemptsUsed = Math.max(0, Number(task?.retry_count || 0));
  
  // Naya Logic: Check targetMet aur isPartial
  const targetMet = result?.targetMet !== undefined ? Boolean(result.targetMet) : Boolean(result?.success);
  const complete = targetMet && !Boolean(result?.isPartial) && Boolean(result?.success);
  
  const retryable = !complete && attemptsUsed < maxAttempts;
  const taskStatus = complete ? 'done' : (retryable ? 'pending' : 'failed');
  const chapterStatus = taskStatus === 'done' ? 'done' : (retryable ? 'in_progress' : 'failed');
  const cumulativeGenerated = Math.max(0, Number(task?.generated_count || 0)) + insertedThisAttempt;
  
  // Error extract karo (round errors ya single error)
  let errorText = null;
  if (taskStatus !== 'done') {
    if (result?.errors && Array.isArray(result.errors) && result.errors.length > 0) {
      errorText = String(result.errors.join(' | ')).slice(0, 1000);
    } else {
      errorText = String(result?.error || result?.message || (result?.isPartial ? 'Partial insert; retry scheduled' : 'Generation failed')).slice(0, 1000);
    }
  }

  return { 
    insertedThisAttempt, 
    attemptsUsed, 
    complete, 
    retryable, 
    taskStatus, 
    chapterStatus, 
    cumulativeGenerated, 
    errorText 
  };
}
