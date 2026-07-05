const params = new URLSearchParams(location.search);
const secondsParam = parseInt(params.get('seconds') || '0', 10) || 0;
const title = params.get('title') || 'Please wait';
const subtitle = params.get('subtitle') || 'Stream should be starting any minute now...';

const body = document.body;
body.style.opacity = '1';

const root = document.querySelector('.container');
const longCountdown = document.getElementById('longCountdown');
const minuteCountdown = document.getElementById('minuteCountdown');
const numberThree = document.getElementById('numberThree');
const numberTwo = document.getElementById('numberTwo');
const numberOne = document.getElementById('numberOne');

let tenthSeconds = secondsParam * 10;

function setEndState() {
  root.innerHTML = `
    <section id="longCountdown" class="show">
      <div class="background">
        <div class="bgUnderlay"></div>
        <div class="bgOverlay"></div>
      </div>
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:white">
        <span class="text" style="display:block;font-size:4em;">${title}</span>
        <span class="countdown" style="display:block;font-size:2em;margin-top:20px;">${subtitle}</span>
      </div>
    </section>`;
}

function updateView() {
  if (tenthSeconds <= 0) {
    setEndState();
    return;
  }

  tenthSeconds--;
  const pureSeconds = Math.ceil(tenthSeconds / 10);
  const hours = Math.floor(pureSeconds / 3600);
  const minutes = Math.floor((pureSeconds % 3600) / 60);
  const seconds = pureSeconds % 60;

  document.querySelector('.cdSecondsPure').textContent = pureSeconds;
  document.querySelector('.cdHours').textContent = hours;
  document.querySelector('.cdMinutes').textContent = String(minutes).padStart(2, '0');
  document.querySelector('.cdSeconds').textContent = String(seconds).padStart(2, '0');

  longCountdown.classList.toggle('show', tenthSeconds > 600);
  minuteCountdown.classList.toggle('show', tenthSeconds <= 600 && tenthSeconds > 20);
  numberThree.classList.toggle('show', tenthSeconds <= 30 && tenthSeconds > 10);
  numberTwo.classList.toggle('show', tenthSeconds <= 20 && tenthSeconds > 5);
  numberOne.classList.toggle('show', tenthSeconds <= 10 && tenthSeconds > 0);
}

if (!secondsParam) {
  setEndState();
} else {
  updateView();
  setInterval(updateView, 100);
}
