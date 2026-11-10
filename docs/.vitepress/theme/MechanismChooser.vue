<script setup lang="ts">
import { computed, reactive } from 'vue';

/**
 * "Which mechanism?" as four questions. Each mechanism lists the answers it suits; picking an
 * answer narrows the list. The same information is in the decision table below it, for readers
 * without JavaScript and for github.com, which renders the markdown but not this component.
 */
type Answers = { who?: string; what?: string; absent?: string; trust?: string };

const questions: { key: keyof Answers; ask: string; options: { id: string; label: string }[] }[] = [
  {
    key: 'who',
    ask: 'Who has to receive it?',
    options: [
      { id: 'child', label: 'One fragment, from its host' },
      { id: 'parent', label: 'The host, from its fragment' },
      { id: 'page', label: 'Any fragment on the page' },
      { id: 'tabs', label: 'Other tabs too' },
      { id: 'capable', label: 'Whoever can handle it' },
      { id: 'server', label: 'The server' },
    ],
  },
  {
    key: 'what',
    ask: 'What is it?',
    options: [
      { id: 'state', label: 'What is true now (a noun)' },
      { id: 'event', label: 'Something that happened (a verb)' },
      { id: 'request', label: 'A request that wants an answer' },
    ],
  },
  {
    key: 'absent',
    ask: 'If the receiver is not there right now?',
    options: [
      { id: 'catchup', label: 'It catches up when it arrives' },
      { id: 'miss', label: 'Fine to miss' },
      { id: 'must', label: 'It must still get it' },
    ],
  },
  {
    key: 'trust',
    ask: 'Is the fragment same-origin and trusted?',
    options: [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No — third party, cross-origin' },
    ],
  },
];

const mechanisms: { name: string; api: string; why: string; link: string; who: string[]; what: string[]; absent: string[]; trust: string[] }[] = [
  { name: 'Slot props', api: 'slot.props · env.props', why: 'The host configures one fragment. Replaced whole, cloned, and current whenever the fragment mounts.', link: '#host-to-one-fragment-slot-props', who: ['child'], what: ['state'], absent: ['catchup'], trust: ['yes', 'no'] },
  { name: 'Slot events', api: 'env.emit → braid:event', why: 'A fragment reports to whoever placed it, and to nobody else.', link: '#fragment-to-its-host-slot-events', who: ['parent'], what: ['event'], absent: ['miss'], trust: ['yes', 'no'] },
  { name: 'Context bus', api: 'braidContext.set · env.context.subscribe', why: 'Host-published state every fragment may read, at its own contract version; granted key by key to untrusted ones.', link: '#host-to-every-fragment-the-context-bus', who: ['child', 'page'], what: ['state'], absent: ['catchup'], trust: ['yes', 'no'] },
  { name: 'Channel state', api: 'channel.broadcast · subscribe', why: 'Fragments share what is true with each other. Last value wins and late subscribers are caught up.', link: '#fragment-to-fragment-what-is-true-channel-state', who: ['page', 'tabs'], what: ['state'], absent: ['catchup'], trust: ['yes'] },
  { name: 'Channel events', api: 'channel.emit · addEventListener', why: 'Something happened; whoever is listening now reacts. Not replayed.', link: '#fragment-to-fragment-what-happened-channel-events', who: ['page', 'tabs'], what: ['event'], absent: ['miss'], trust: ['yes'] },
  { name: 'Durable events', api: "emit(…, { delivery: 'at-least-once' })", why: 'A queue per consumer on disk. Delivered when the consumer next mounts; retried until its handler succeeds.', link: '#an-event-nobody-may-miss-durable-events', who: ['page', 'tabs'], what: ['event'], absent: ['must'], trust: ['yes'] },
  { name: 'Intents', api: 'bus.raiseIntent · addIntentListener', why: 'Ask whoever can do this to do it, and get the result or the error back.', link: '#ask-and-get-an-answer-intents', who: ['capable'], what: ['request'], absent: ['miss'], trust: ['yes'] },
  { name: 'FDC3', api: 'fdc3.broadcast · fdc3.raiseIntent', why: 'The same two ideas in the financial desktop standard, for apps written to it. An intent can launch the app that handles it.', link: '#apps-written-to-a-standard-fdc3', who: ['page', 'capable'], what: ['state', 'request'], absent: ['catchup', 'must'], trust: ['yes'] },
  { name: 'Invalidation tags', api: 'invalidator.invalidate(tag)', why: 'Tell every tab its copy is stale, without sending the data. Each refetches for itself.', link: '#across-tabs', who: ['page', 'tabs'], what: ['event'], absent: ['miss'], trust: ['yes'] },
  { name: 'Persisted state and records', api: 'channel(…, { persist: true }) · createRecordStore', why: 'State that has to be there after a reload or a deploy, read at the reader’s schema version.', link: '#across-reloads-and-deploys', who: ['page', 'tabs'], what: ['state'], absent: ['must'], trust: ['yes'] },
  { name: 'Outbox', api: 'createOutbox · drainOutbox', why: 'A write the server must receive, queued on disk and sent once by one tab, online or later.', link: '#to-the-server-even-offline-the-outbox', who: ['server'], what: ['request', 'event'], absent: ['must'], trust: ['yes'] },
];

const answers = reactive<Answers>({});
const matches = computed(() =>
  mechanisms.filter((mechanism) => questions.every(({ key }) => answers[key] === undefined || mechanism[key].includes(answers[key]!))),
);
const answered = computed(() => questions.some(({ key }) => answers[key] !== undefined));
const pick = (key: keyof Answers, id: string) => (answers[key] = answers[key] === id ? undefined : id);
const reset = () => questions.forEach(({ key }) => (answers[key] = undefined));
</script>

<template>
  <div class="chooser">
    <fieldset v-for="question in questions" :key="question.key" class="chooser-q">
      <legend>{{ question.ask }}</legend>
      <button
        v-for="option in question.options"
        :key="option.id"
        type="button"
        class="chooser-pill"
        :aria-pressed="answers[question.key] === option.id"
        @click="pick(question.key, option.id)"
      >
        {{ option.label }}
      </button>
    </fieldset>
    <div class="chooser-results" aria-live="polite">
      <p class="chooser-count">
        <template v-if="!answered">Answer any of the questions — every mechanism is listed until you do.</template>
        <template v-else-if="matches.length === 0">No single mechanism does all of that. Combine two: see <a href="#combining-them">Combining them</a>.</template>
        <template v-else>{{ matches.length }} {{ matches.length === 1 ? 'mechanism fits' : 'mechanisms fit' }}.</template>
        <button v-if="answered" type="button" class="chooser-reset" @click="reset">Start over</button>
      </p>
      <ul>
        <li v-for="mechanism in matches" :key="mechanism.name">
          <a :href="mechanism.link"><strong>{{ mechanism.name }}</strong></a>
          <code>{{ mechanism.api }}</code>
          <span>{{ mechanism.why }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
