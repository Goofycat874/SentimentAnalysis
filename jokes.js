/* Clean, family-friendly jokes used by the "Cheer me up" feature.
   next() returns them in shuffled order and only repeats once every joke has been told. */
window.Jokes = (() => {
  'use strict';

  const JOKES = [
    ['Why don\'t skeletons fight each other?', 'They don\'t have the guts.'],
    ['What do you call a fake noodle?', 'An impasta.'],
    ['Why did the scarecrow win an award?', 'He was outstanding in his field.'],
    ['Why don\'t eggs tell jokes?', 'They\'d crack each other up.'],
    ['What do you call a bear with no teeth?', 'A gummy bear.'],
    ['Why can\'t a bicycle stand up by itself?', 'It\'s two tired.'],
    ['What did the ocean say to the beach?', 'Nothing, it just waved.'],
    ['Why did the math book look so sad?', 'It had too many problems.'],
    ['What do you call cheese that isn\'t yours?', 'Nacho cheese.'],
    ['Why did the cookie go to the doctor?', 'It was feeling crummy.'],
    ['How does a penguin build its house?', 'Igloos it together.'],
    ['Why are elevator jokes so good?', 'They work on so many levels.'],
    ['What do you call a sleeping dinosaur?', 'A dino-snore.'],
    ['Why did the golfer bring two pairs of pants?', 'In case he got a hole in one.'],
    ['What do you call a fish wearing a bowtie?', 'Sofishticated.'],
    ['Why don\'t programmers like nature?', 'It has too many bugs.'],
    ['How do you organize a space party?', 'You planet.'],
    ['What did one wall say to the other wall?', 'I\'ll meet you at the corner.'],
    ['Why did the tomato turn red?', 'It saw the salad dressing.'],
    ['What do you call a pile of cats?', 'A meowtain.'],
    ['Why was the computer cold?', 'It left its Windows open.'],
    ['What has ears but cannot hear?', 'A cornfield.'],
    ['Why did the banana go to the doctor?', 'It wasn\'t peeling well.'],
    ['What do you call a dog magician?', 'A labracadabrador.'],
    ['Why do cows wear bells?', 'Because their horns don\'t work.'],
    ['What did the grape do when it got stepped on?', 'It let out a little wine.'],
    ['Why did the stadium get hot after the game?', 'All the fans left.'],
    ['What kind of tree fits in your hand?', 'A palm tree.'],
    ['Why couldn\'t the leopard play hide and seek?', 'He was always spotted.'],
    ['What do you call an alligator in a vest?', 'An investigator.'],
    ['Why did the picture go to jail?', 'It was framed.'],
    ['What do clouds wear under their clothes?', 'Thunderwear.'],
    ['How do you make a tissue dance?', 'Put a little boogie in it.'],
    ['Why did the music teacher need a ladder?', 'To reach the high notes.'],
    ['What do you call a belt made of watches?', 'A waist of time.'],
    ['Why was the broom late?', 'It over-swept.'],
    ['What did the zero say to the eight?', 'Nice belt.'],
    ['Why do bees have sticky hair?', 'They use honeycombs.'],
    ['What do you call a snowman with a six-pack?', 'An abdominal snowman.'],
    ['Why did the phone wear glasses?', 'It lost all its contacts.'],
    ['What\'s orange and sounds like a parrot?', 'A carrot.'],
    ['Why did the bicycle fall asleep?', 'It was wheely tired.'],
  ];

  let deck = [];

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  return {
    next() {
      if (!deck.length) deck = shuffle(JOKES.slice());
      const [setup, punchline] = deck.pop();
      return { setup, punchline };
    },
  };
})();
