import type { Article, Card } from './types.ts'
import { newSrs } from './srs.ts'

type Seed = {
  de: string
  en: string
  article: Article
  example_de: string
  example_en: string
  tags: string[]
}

const SEED: Seed[] = [
  { de: 'Mann', en: 'man', article: 'der', example_de: 'Der Mann liest ein Buch.', example_en: 'The man is reading a book.', tags: ['a1', 'noun'] },
  { de: 'Frau', en: 'woman', article: 'die', example_de: 'Die Frau trinkt Kaffee.', example_en: 'The woman is drinking coffee.', tags: ['a1', 'noun'] },
  { de: 'Kind', en: 'child', article: 'das', example_de: 'Das Kind spielt im Garten.', example_en: 'The child is playing in the garden.', tags: ['a1', 'noun'] },
  { de: 'Junge', en: 'boy', article: 'der', example_de: 'Der Junge geht zur Schule.', example_en: 'The boy is going to school.', tags: ['a1', 'noun'] },
  { de: 'Mädchen', en: 'girl', article: 'das', example_de: 'Das Mädchen malt ein Bild.', example_en: 'The girl is painting a picture.', tags: ['a1', 'noun'] },
  { de: 'Tisch', en: 'table', article: 'der', example_de: 'Der Tisch ist groß.', example_en: 'The table is big.', tags: ['a1', 'noun'] },
  { de: 'Stuhl', en: 'chair', article: 'der', example_de: 'Der Stuhl ist bequem.', example_en: 'The chair is comfortable.', tags: ['a1', 'noun'] },
  { de: 'Buch', en: 'book', article: 'das', example_de: 'Das Buch ist interessant.', example_en: 'The book is interesting.', tags: ['a1', 'noun'] },
  { de: 'Tür', en: 'door', article: 'die', example_de: 'Die Tür ist offen.', example_en: 'The door is open.', tags: ['a1', 'noun'] },
  { de: 'Fenster', en: 'window', article: 'das', example_de: 'Das Fenster ist geschlossen.', example_en: 'The window is closed.', tags: ['a1', 'noun'] },
  { de: 'Haus', en: 'house', article: 'das', example_de: 'Das Haus ist alt.', example_en: 'The house is old.', tags: ['a1', 'noun'] },
  { de: 'Wohnung', en: 'apartment', article: 'die', example_de: 'Die Wohnung ist klein.', example_en: 'The apartment is small.', tags: ['a1', 'noun'] },
  { de: 'Hund', en: 'dog', article: 'der', example_de: 'Der Hund läuft schnell.', example_en: 'The dog runs fast.', tags: ['a1', 'noun'] },
  { de: 'Katze', en: 'cat', article: 'die', example_de: 'Die Katze schläft.', example_en: 'The cat is sleeping.', tags: ['a1', 'noun'] },
  { de: 'Auto', en: 'car', article: 'das', example_de: 'Das Auto ist rot.', example_en: 'The car is red.', tags: ['a1', 'noun'] },
  { de: 'Zug', en: 'train', article: 'der', example_de: 'Der Zug kommt um acht.', example_en: 'The train arrives at eight.', tags: ['a1', 'noun'] },
  { de: 'Stadt', en: 'city', article: 'die', example_de: 'Die Stadt ist schön.', example_en: 'The city is beautiful.', tags: ['a1', 'noun'] },
  { de: 'Land', en: 'country', article: 'das', example_de: 'Deutschland ist ein Land.', example_en: 'Germany is a country.', tags: ['a1', 'noun'] },
  { de: 'Tag', en: 'day', article: 'der', example_de: 'Der Tag ist lang.', example_en: 'The day is long.', tags: ['a1', 'noun'] },
  { de: 'Nacht', en: 'night', article: 'die', example_de: 'Die Nacht ist dunkel.', example_en: 'The night is dark.', tags: ['a1', 'noun'] },
  { de: 'Morgen', en: 'morning', article: 'der', example_de: 'Der Morgen ist kalt.', example_en: 'The morning is cold.', tags: ['a1', 'noun'] },
  { de: 'Abend', en: 'evening', article: 'der', example_de: 'Der Abend ist ruhig.', example_en: 'The evening is quiet.', tags: ['a1', 'noun'] },
  { de: 'Woche', en: 'week', article: 'die', example_de: 'Die Woche hat sieben Tage.', example_en: 'The week has seven days.', tags: ['a1', 'noun'] },
  { de: 'Monat', en: 'month', article: 'der', example_de: 'Der Monat ist Januar.', example_en: 'The month is January.', tags: ['a1', 'noun'] },
  { de: 'Jahr', en: 'year', article: 'das', example_de: 'Das Jahr hat zwölf Monate.', example_en: 'The year has twelve months.', tags: ['a1', 'noun'] },
  { de: 'Wasser', en: 'water', article: 'das', example_de: 'Das Wasser ist kalt.', example_en: 'The water is cold.', tags: ['a1', 'noun'] },
  { de: 'Brot', en: 'bread', article: 'das', example_de: 'Das Brot schmeckt gut.', example_en: 'The bread tastes good.', tags: ['a1', 'noun'] },
  { de: 'Kaffee', en: 'coffee', article: 'der', example_de: 'Der Kaffee ist heiß.', example_en: 'The coffee is hot.', tags: ['a1', 'noun'] },
  { de: 'Apfel', en: 'apple', article: 'der', example_de: 'Der Apfel ist rot.', example_en: 'The apple is red.', tags: ['a1', 'noun'] },
  { de: 'Milch', en: 'milk', article: 'die', example_de: 'Die Milch ist frisch.', example_en: 'The milk is fresh.', tags: ['a1', 'noun'] },
  { de: 'Schule', en: 'school', article: 'die', example_de: 'Die Schule beginnt um acht.', example_en: 'School starts at eight.', tags: ['a1', 'noun'] },
  { de: 'Lehrer', en: 'teacher (m)', article: 'der', example_de: 'Der Lehrer erklärt die Aufgabe.', example_en: 'The teacher explains the exercise.', tags: ['a1', 'noun'] },
  { de: 'Lehrerin', en: 'teacher (f)', article: 'die', example_de: 'Die Lehrerin ist nett.', example_en: 'The teacher is nice.', tags: ['a1', 'noun'] },
  { de: 'Freund', en: 'friend (m)', article: 'der', example_de: 'Der Freund wohnt in Berlin.', example_en: 'The friend lives in Berlin.', tags: ['a1', 'noun'] },
  { de: 'Freundin', en: 'friend (f)', article: 'die', example_de: 'Die Freundin kommt morgen.', example_en: 'The friend is coming tomorrow.', tags: ['a1', 'noun'] },
  { de: 'Zeit', en: 'time', article: 'die', example_de: 'Die Zeit vergeht schnell.', example_en: 'Time passes quickly.', tags: ['a1', 'noun'] },
  { de: 'Geld', en: 'money', article: 'das', example_de: 'Das Geld ist im Portemonnaie.', example_en: 'The money is in the wallet.', tags: ['a1', 'noun'] },
  { de: 'Arbeit', en: 'work', article: 'die', example_de: 'Die Arbeit macht Spaß.', example_en: 'The work is fun.', tags: ['a1', 'noun'] },
  { de: 'Name', en: 'name', article: 'der', example_de: 'Mein Name ist Anna.', example_en: 'My name is Anna.', tags: ['a1', 'noun'] },
  { de: 'Straße', en: 'street', article: 'die', example_de: 'Die Straße ist laut.', example_en: 'The street is loud.', tags: ['a1', 'noun'] },
  { de: 'sein', en: 'to be', article: 'none', example_de: 'Ich bin müde.', example_en: 'I am tired.', tags: ['a1', 'verb'] },
  { de: 'haben', en: 'to have', article: 'none', example_de: 'Ich habe ein Auto.', example_en: 'I have a car.', tags: ['a1', 'verb'] },
  { de: 'gehen', en: 'to go', article: 'none', example_de: 'Wir gehen nach Hause.', example_en: 'We are going home.', tags: ['a1', 'verb'] },
  { de: 'kommen', en: 'to come', article: 'none', example_de: 'Kommst du mit?', example_en: 'Are you coming along?', tags: ['a1', 'verb'] },
  { de: 'machen', en: 'to do / to make', article: 'none', example_de: 'Was machst du?', example_en: 'What are you doing?', tags: ['a1', 'verb'] },
  { de: 'sehen', en: 'to see', article: 'none', example_de: 'Ich sehe den Hund.', example_en: 'I see the dog.', tags: ['a1', 'verb'] },
  { de: 'essen', en: 'to eat', article: 'none', example_de: 'Wir essen Brot.', example_en: 'We are eating bread.', tags: ['a1', 'verb'] },
  { de: 'trinken', en: 'to drink', article: 'none', example_de: 'Sie trinkt Wasser.', example_en: 'She is drinking water.', tags: ['a1', 'verb'] },
  { de: 'sprechen', en: 'to speak', article: 'none', example_de: 'Ich spreche Deutsch.', example_en: 'I speak German.', tags: ['a1', 'verb'] },
  { de: 'lernen', en: 'to learn', article: 'none', example_de: 'Wir lernen Deutsch.', example_en: 'We are learning German.', tags: ['a1', 'verb'] },
]

export function seedCards(now = Date.now()): Card[] {
  return SEED.map((row, i) => ({
    id: `seed-${String(i + 1).padStart(2, '0')}`,
    de: row.de,
    en: row.en,
    article: row.article,
    example_de: row.example_de,
    example_en: row.example_en,
    tags: row.tags,
    created_at: now,
    updated_at: now,
    srs: newSrs(now),
  }))
}

export const SEED_COUNT = SEED.length
