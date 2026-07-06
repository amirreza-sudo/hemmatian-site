/* dxb-agent-widget.js — DXB Property Expert AI Concierge widget
   Embed with: <script src="/widget/dxb-agent-widget.js" defer></script>
   Talks to /.netlify/functions/dxb-agent
*/
(function () {
  const ENDPOINT = '/.netlify/functions/dxb-agent';
  const LANGS = {
    fa: { code: 'fa-IR', label: 'فارسی', placeholder: 'پیام خود را بنویسید یا میکروفون را بزنید...' },
    ar: { code: 'ar-AE', label: 'العربية', placeholder: 'اكتب رسالتك أو اضغط على الميكروفون...' },
    en: { code: 'en-US', label: 'English', placeholder: 'Type a message or tap the mic...' }
  };
  let currentLang = 'en';
  let history = [];
  let recognizing = false;

  // ── Styles ──────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #dxb-agent-btn{position:fixed;bottom:90px;right:18px;width:64px;height:64px;border-radius:50%;
      background:#d97706;border:none;color:#111;font-size:28px;cursor:pointer;z-index:9998;
      display:flex;align-items:center;justify-content:center;box-shadow:0 4px 24px rgba(217,119,6,.5);
      transition:transform .2s;animation:dxb-pulse 2.5s infinite}
    #dxb-agent-btn:hover{transform:scale(1.08)}
    @keyframes dxb-pulse{
      0%{box-shadow:0 4px 24px rgba(217,119,6,.5),0 0 0 0 rgba(217,119,6,.5)}
      70%{box-shadow:0 4px 24px rgba(217,119,6,.5),0 0 0 14px rgba(217,119,6,0)}
      100%{box-shadow:0 4px 24px rgba(217,119,6,.5),0 0 0 0 rgba(217,119,6,0)}
    }
    #dxb-agent-badge{position:fixed;bottom:148px;right:16px;background:#111;color:#fff;font-size:11px;
      padding:5px 10px;border-radius:14px;z-index:9998;font-family:Inter,sans-serif;white-space:nowrap;
      border:1px solid rgba(217,119,6,.4)}
    @media (min-width:768px){
      #dxb-agent-btn{bottom:24px;right:24px}
      #dxb-agent-badge{bottom:82px;right:22px}
    }
    #dxb-agent-panel{position:fixed;bottom:166px;right:18px;width:360px;max-width:92vw;height:520px;max-height:70vh;
      background:#181818;border:1px solid rgba(217,119,6,.3);border-radius:12px;display:none;flex-direction:column;
      z-index:9999;font-family:Inter,sans-serif;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.5)}
    @media (min-width:768px){ #dxb-agent-panel{bottom:96px;right:24px} }
    #dxb-agent-panel.open{display:flex}
    #dxb-agent-head{padding:14px 16px;background:#111;display:flex;justify-content:space-between;align-items:center;
      border-bottom:1px solid rgba(217,119,6,.2)}
    #dxb-agent-head span{color:#fff;font-size:13px;font-weight:700;letter-spacing:.5px}
    #dxb-lang-select{background:#222;color:#d97706;border:1px solid rgba(217,119,6,.3);border-radius:4px;
      font-size:11px;padding:3px 6px}
    #dxb-agent-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
    .dxb-msg{max-width:85%;padding:9px 12px;border-radius:10px;font-size:13px;line-height:1.5}
    .dxb-msg.user{align-self:flex-end;background:#d97706;color:#111}
    .dxb-msg.bot{align-self:flex-start;background:#262626;color:#eee}
    #dxb-agent-input-row{display:flex;gap:6px;padding:10px;border-top:1px solid rgba(217,119,6,.2);background:#151515}
    #dxb-agent-text{flex:1;background:#222;border:1px solid rgba(255,255,255,.1);border-radius:6px;color:#fff;
      padding:9px 10px;font-size:13px;font-family:inherit;resize:none}
    #dxb-mic-btn,#dxb-send-btn{background:#d97706;border:none;border-radius:6px;color:#111;width:38px;
      cursor:pointer;font-size:15px}
    #dxb-mic-btn.rec{background:#e11d48;color:#fff}
  `;
  document.head.appendChild(style);

  // ── DOM ─────────────────────────────────────────────────
  const btn = document.createElement('button');
  btn.id = 'dxb-agent-btn';
  btn.innerHTML = '💬';
  document.body.appendChild(btn);

  const badge = document.createElement('div');
  badge.id = 'dxb-agent-badge';
  badge.textContent = 'Ask me anything →';
  document.body.appendChild(badge);

  const panel = document.createElement('div');
  panel.id = 'dxb-agent-panel';
  panel.innerHTML = `
    <div id="dxb-agent-head">
      <span>AmirReza's Assistant</span>
      <select id="dxb-lang-select">
        <option value="en">EN</option>
        <option value="fa">فا</option>
        <option value="ar">AR</option>
      </select>
    </div>
    <div id="dxb-agent-msgs"></div>
    <div id="dxb-agent-input-row">
      <button id="dxb-mic-btn" title="Voice">🎤</button>
      <textarea id="dxb-agent-text" rows="1"></textarea>
      <button id="dxb-send-btn" title="Send">➤</button>
    </div>
  `;
  document.body.appendChild(panel);

  const msgsEl = panel.querySelector('#dxb-agent-msgs');
  const textEl = panel.querySelector('#dxb-agent-text');
  const langSelect = panel.querySelector('#dxb-lang-select');
  const micBtn = panel.querySelector('#dxb-mic-btn');
  const sendBtn = panel.querySelector('#dxb-send-btn');

  btn.addEventListener('click', () => {
    panel.classList.toggle('open');
    badge.style.display = 'none';
    btn.style.animation = 'none';
    if (panel.classList.contains('open') && msgsEl.children.length === 0) {
      addMsg('bot', currentLang === 'fa'
        ? 'سلام! من دستیار امیررضا هستم. چطور می‌تونم کمکتون کنم؟'
        : currentLang === 'ar'
        ? 'مرحباً! أنا مساعد أمير رضا. كيف يمكنني مساعدتك؟'
        : "Hi! I'm AmirReza's assistant. How can I help you today?");
    }
  });

  langSelect.addEventListener('change', () => {
    currentLang = langSelect.value;
    textEl.placeholder = LANGS[currentLang].placeholder;
    textEl.dir = currentLang === 'en' ? 'ltr' : 'rtl';
  });
  textEl.placeholder = LANGS[currentLang].placeholder;

  function addMsg(role, text) {
    const div = document.createElement('div');
    div.className = 'dxb-msg ' + (role === 'user' ? 'user' : 'bot');
    div.textContent = text;
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  async function sendMessage(text) {
    if (!text.trim()) return;
    addMsg('user', text);
    textEl.value = '';
    history.push({ role: 'user', content: text });

    const thinking = document.createElement('div');
    thinking.className = 'dxb-msg bot';
    thinking.textContent = '...';
    msgsEl.appendChild(thinking);
    msgsEl.scrollTop = msgsEl.scrollHeight;

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history: history.slice(-10) })
      });
      const data = await res.json();
      thinking.remove();
      const reply = data.reply || (currentLang === 'fa' ? 'مشکلی پیش اومد، لطفا دوباره امتحان کنید.' : 'Something went wrong, please try again.');
      addMsg('bot', reply);
      history.push({ role: 'assistant', content: reply });
      speak(reply);
    } catch (e) {
      thinking.remove();
      addMsg('bot', 'Connection error — please try again or message AmirReza directly on WhatsApp.');
    }
  }

  sendBtn.addEventListener('click', () => sendMessage(textEl.value));
  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(textEl.value); }
  });

  // ── Voice input (Web Speech API) ───────────────────────
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognizer = null;
  if (SpeechRecognition) {
    recognizer = new SpeechRecognition();
    recognizer.interimResults = false;
    recognizer.maxAlternatives = 1;

    recognizer.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      sendMessage(transcript);
    };
    recognizer.onend = () => { recognizing = false; micBtn.classList.remove('rec'); };
    recognizer.onerror = (e) => {
      recognizing = false;
      micBtn.classList.remove('rec');
      let msg = currentLang === 'fa'
        ? 'میکروفون کار نکرد. لطفا اجازه دسترسی به میکروفون رو بدید یا پیامتون رو تایپ کنید.'
        : currentLang === 'ar'
        ? 'لم يعمل الميكروفون. يرجى السماح بالوصول أو كتابة رسالتك.'
        : "Voice didn't work — please allow microphone access, or just type your message.";
      if (e.error === 'not-allowed' || e.error === 'permission-denied') {
        msg = currentLang === 'fa'
          ? 'دسترسی میکروفون رد شد. در تنظیمات مرورگر اجازه بدید یا تایپ کنید.'
          : currentLang === 'ar'
          ? 'تم رفض إذن الميكروفون. يرجى تمكينه من إعدادات المتصفح أو الكتابة.'
          : 'Microphone permission was denied — enable it in your browser settings, or just type instead.';
      }
      addMsg('bot', msg);
    };

    micBtn.addEventListener('click', () => {
      if (recognizing) { recognizer.stop(); return; }
      recognizer.lang = LANGS[currentLang].code;
      try {
        recognizer.start();
        recognizing = true;
        micBtn.classList.add('rec');
      } catch (err) {
        addMsg('bot', currentLang === 'fa' ? 'میکروفون در دسترس نیست.' : 'Microphone not available right now.');
      }
    });
  } else {
    micBtn.addEventListener('click', () => {
      addMsg('bot', currentLang === 'fa'
        ? 'این دکمه در این مرورگر کار نمی‌کنه. روی کادر متن ضربه بزنید و از میکروفون خود صفحه‌کلید آیفون استفاده کنید.'
        : "Voice input isn't supported in this browser. Tap the text box and use your keyboard's own dictation mic instead.");
    });
  }

  // ── Voice output (TTS) ──────────────────────────────────
  function speak(text) {
    if (!window.speechSynthesis) return;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = LANGS[currentLang].code;
    window.speechSynthesis.speak(utter);
  }
})();
