"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";
import {
  addTerm,
  deleteQuestion,
  deleteTerm,
  publishTest,
  saveQuestion,
  submitTest,
  writeMissingTests,
  writeTest,
} from "@/lib/quizActions";

type State = { success: boolean; error: boolean; message?: string };
const initial: State = { success: false, error: false };

const LETTERS = ["A", "B", "C", "D"];

// Toasts the result and reloads the page's data after a successful action
const useResult = (state: State, { quiet = false } = {}) => {
  const router = useRouter();
  useEffect(() => {
    if (state.success) {
      if (state.message && !quiet) toast(state.message);
      router.refresh();
    }
    if (state.error) toast.error(state.message ?? "Something went wrong.");
  }, [state, router, quiet]);
};

const smallButton =
  "rounded-full px-3 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-60";

export const WriteTestButton = ({
  kind,
  id,
  rewrite = false,
}: {
  kind: "video" | "material";
  id: number;
  rewrite?: boolean;
}) => {
  const [state, action, pending] = useActionState(writeTest, initial);
  const [confirming, setConfirming] = useState(false);
  useResult(state);

  if (rewrite && !confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className={`${smallButton} bg-gray-100 text-gray-700 hover:bg-gray-200`}>
        Rewrite
      </button>
    );
  }
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="id" value={id} />
      <button className={`${smallButton} bg-indigo-500 text-white hover:bg-indigo-600`} disabled={pending}>
        {pending ? "Starting..." : rewrite ? "Replace the questions" : "Write test"}
      </button>
      {rewrite && (
        <button type="button" className="text-xs text-gray-500" onClick={() => setConfirming(false)}>
          Cancel
        </button>
      )}
    </form>
  );
};

export const WriteMissingTests = ({ missing }: { missing: number }) => {
  const [state, action, pending] = useActionState(writeMissingTests, initial);
  useResult(state);
  if (missing === 0) return null;
  return (
    <form action={action}>
      <button className="btn-primary" disabled={pending}>
        {pending ? "Starting..." : `Write missing tests (${missing})`}
      </button>
    </form>
  );
};

export const PublishTestButton = ({ id, published }: { id: number; published: boolean }) => {
  const [state, action, pending] = useActionState(publishTest, initial);
  useResult(state);
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="publish" value={published ? "0" : "1"} />
      <button
        className={`${smallButton} ${published ? "bg-gray-100 text-gray-700 hover:bg-gray-200" : "bg-green-600 text-white hover:bg-green-700"}`}
        disabled={pending}
      >
        {pending ? "Saving..." : published ? "Unpublish" : "Publish"}
      </button>
    </form>
  );
};

// While Claude writes a test, the page reloads itself to show when it's done
export const RefreshWhileWriting = ({ active }: { active: boolean }) => {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 10000);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
};

export type EditableQuestion = {
  id: number;
  question: string;
  options: string[];
  answer: number;
  marks: number;
  explanation: string | null;
};

export const QuestionEditor = ({
  number,
  question,
  locked,
}: {
  number: number;
  question: EditableQuestion;
  locked: boolean;
}) => {
  const [editing, setEditing] = useState(false);
  // Closes the editor once the question is saved
  const [saveState, save, saving] = useActionState(async (state: State, formData: FormData) => {
    const result = await saveQuestion(state, formData);
    if (result.success) setEditing(false);
    return result;
  }, initial);
  const [delState, remove, removing] = useActionState(deleteQuestion, initial);
  useResult(saveState, { quiet: true });
  useResult(delState);

  if (!editing) {
    return (
      <li className="rounded-lg border border-gray-200 p-4 flex flex-col gap-2">
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm font-medium text-gray-900 whitespace-pre-line">
            {number}. {question.question}
          </p>
          <span className="shrink-0 text-xs text-gray-500">{question.marks} marks</span>
        </div>
        <ol className="flex flex-col gap-1 text-sm">
          {question.options.map((option, i) => (
            <li
              key={i}
              className={`rounded-md px-2 py-1 ${i === question.answer ? "bg-green-50 text-green-800 font-medium" : "text-gray-700"}`}
            >
              {LETTERS[i]}. {option}
              {i === question.answer && <span className="sr-only"> (correct answer)</span>}
            </li>
          ))}
        </ol>
        {question.explanation && <p className="text-xs text-gray-500">Why: {question.explanation}</p>}
        {!locked && (
          <div className="flex items-center gap-3">
            <button type="button" className="text-xs text-indigo-600 hover:underline" onClick={() => setEditing(true)}>
              Edit
            </button>
            <form action={remove}>
              <input type="hidden" name="id" value={question.id} />
              <button className="text-xs text-red-600 hover:underline disabled:opacity-60" disabled={removing}>
                {removing ? "Removing..." : "Remove"}
              </button>
            </form>
          </div>
        )}
      </li>
    );
  }

  return (
    <li className="rounded-lg border border-indigo-200 p-4">
      <form action={save} className="flex flex-col gap-3">
        <input type="hidden" name="id" value={question.id} />
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
          Question {number}
          <textarea name="question" defaultValue={question.question} required rows={2} className="form-control" />
        </label>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-medium text-gray-600 mb-1">Options (choose the correct one)</legend>
          {question.options.map((option, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="radio"
                name="answer"
                value={i}
                defaultChecked={i === question.answer}
                aria-label={`Option ${LETTERS[i]} is correct`}
                className="accent-green-600"
              />
              <span className="w-4 text-sm text-gray-500">{LETTERS[i]}</span>
              <input name={`option${i}`} defaultValue={option} required className="form-control" />
            </div>
          ))}
        </fieldset>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
          Explanation shown after handing in (optional)
          <textarea name="explanation" defaultValue={question.explanation ?? ""} rows={2} className="form-control" />
        </label>
        <div className="flex items-center gap-3">
          <button className="btn-primary" disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </button>
          <button type="button" className="text-sm text-gray-500" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </form>
    </li>
  );
};

export const TakeTestForm = ({
  quizId,
  questions,
}: {
  quizId: number;
  questions: { id: number; question: string; options: string[]; marks: number }[];
}) => {
  const [state, action, pending] = useActionState(submitTest, initial);
  const [answered, setAnswered] = useState<Record<number, boolean>>({});
  useResult(state);
  const left = questions.length - Object.keys(answered).length;

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="quizId" value={quizId} />
      <ol className="flex flex-col gap-4">
        {questions.map((q, n) => (
          <li key={q.id} className="rounded-lg border border-gray-200 p-4">
            <fieldset className="flex flex-col gap-2">
              <legend className="flex w-full items-start justify-between gap-4 text-sm font-medium text-gray-900">
                <span className="whitespace-pre-line">
                  {n + 1}. {q.question}
                </span>
                <span className="shrink-0 text-xs font-normal text-gray-500">{q.marks} marks</span>
              </legend>
              {q.options.map((option, i) => (
                <label
                  key={i}
                  className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-50 has-[:checked]:bg-lamaSkyLight"
                >
                  <input
                    type="radio"
                    name={`q${q.id}`}
                    value={i}
                    required
                    className="mt-0.5 accent-indigo-500"
                    onChange={() => setAnswered((a) => ({ ...a, [q.id]: true }))}
                  />
                  <span>
                    {LETTERS[i]}. {option}
                  </span>
                </label>
              ))}
            </fieldset>
          </li>
        ))}
      </ol>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <p className="text-sm text-gray-500">
          {left > 0
            ? `${left} question${left === 1 ? "" : "s"} still to answer. You get one go, so check your answers first.`
            : "All answered. You get one go, so check your answers before you hand in."}
        </p>
        <button className="btn-primary" disabled={pending || left > 0}>
          {pending ? "Marking..." : "Hand in"}
        </button>
      </div>
    </form>
  );
};

export const TermsManager = ({
  terms,
}: {
  terms: { id: number; name: string; dates: string; current: boolean }[];
}) => {
  const [addState, add, adding] = useActionState(addTerm, initial);
  const [delState, remove] = useActionState(deleteTerm, initial);
  const formRef = useRef<HTMLFormElement>(null);
  useResult(addState, { quiet: true });
  useResult(delState, { quiet: true });

  useEffect(() => {
    if (addState.success) formRef.current?.reset();
  }, [addState]);

  return (
    <div className="flex flex-col gap-4">
      {terms.length === 0 ? (
        <p className="text-sm text-gray-500">No terms yet. Add this year&apos;s terms so learners can see their readiness.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-gray-100">
          {terms.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-4 py-2 text-sm">
              <span>
                <span className="font-medium text-gray-900">{t.name}</span>{" "}
                <span className="text-gray-500">· {t.dates}</span>
                {t.current && (
                  <span className="ml-2 rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800">Current</span>
                )}
              </span>
              <form action={remove}>
                <input type="hidden" name="id" value={t.id} />
                <button className="text-xs text-red-600 hover:underline">Remove</button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <form ref={formRef} action={add} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
          Name
          <input name="name" required placeholder="Term 1 2027" className="form-control" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
          First day
          <input name="startDate" type="date" required className="form-control" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
          Last day
          <input name="endDate" type="date" required className="form-control" />
        </label>
        <button className="btn-primary" disabled={adding}>
          {adding ? "Adding..." : "Add term"}
        </button>
      </form>
    </div>
  );
};
