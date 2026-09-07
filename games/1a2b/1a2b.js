// 遊戲狀態變數
        let answer = "";
        let isGameOver = false;
        let count = 0;
        let historyData = [];

        const inputs = document.querySelectorAll('.digit-input');
        const submitBtn = document.getElementById('submitBtn');
        const restartBtn = document.getElementById('restartBtn');
        const msgBox = document.getElementById('msgBox');
        const historyList = document.getElementById('historyList');
        const guessCountSpan = document.getElementById('guessCount');
        const currentResultDiv = document.getElementById('currentResult');

        const STORAGE_KEY = '1a2b_game_state';

        function saveGameState() {
            try {
                const state = {
                    answer: answer,
                    isGameOver: isGameOver,
                    count: count,
                    historyData: historyData
                };
                localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            } catch (e) {
                console.warn('Unable to save 1A2B state to localStorage', e);
            }
        }

        function loadGameState() {
            try {
                const savedState = localStorage.getItem(STORAGE_KEY);
                if (savedState) {
                    const state = JSON.parse(savedState);
                    answer = state.answer;
                    isGameOver = state.isGameOver;
                    count = state.count;
                    historyData = state.historyData || [];

                    guessCountSpan.textContent = count;
                    historyList.innerHTML = "";

                    // 修正點：移除 .reverse()。
                    // 因為 renderHistoryDOM 內部是用 prepend (插在最上方)，
                    // 依照原本 [舊 -> 新] 的順序推入，最後一筆新的自然會被擠到最上面。
                    historyData.forEach(item => {
                        renderHistoryDOM(item.guess, item.result);
                    });

                    if (historyData.length > 0) {
                        const lastResult = historyData[historyData.length - 1].result;
                        currentResultDiv.textContent = lastResult;
                        currentResultDiv.classList.add('show');
                        if (lastResult === "4A0B") {
                            currentResultDiv.classList.add('win');
                        }
                    }

                    if (isGameOver) {
                        gameWinUI();
                    }

                    console.log("已恢復上次遊戲進度，謎底: " + answer);
                } else {
                    initGame(true);
                }
            } catch (e) {
                console.warn('Unable to load 1A2B state from localStorage', e);
                initGame(true);
            }
        }

        function initGame(forceNew = false) {
            if (forceNew) {
                try {
                    localStorage.removeItem(STORAGE_KEY);
                } catch (_) {}
                answer = generateAnswer();
                isGameOver = false;
                count = 0;
                historyData = [];
                saveGameState();
                console.log("新局謎底: " + answer);
            }

            guessCountSpan.textContent = count;

            inputs.forEach(input => {
                input.value = "";
                input.disabled = false;
                input.style.borderColor = "var(--border-color)";
            });

            submitBtn.disabled = false;
            restartBtn.style.display = "none";
            msgBox.textContent = "";

            if (forceNew) {
                historyList.innerHTML = "";
                currentResultDiv.textContent = "";
                currentResultDiv.classList.remove('show', 'win');
                inputs[0].focus();
            }
        }

        function generateAnswer() {
            const nums = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
            for (let i = nums.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [nums[i], nums[j]] = [nums[j], nums[i]];
            }
            return nums.slice(0, 4).join('');
        }

        inputs.forEach((input, index) => {
            input.addEventListener('input', (e) => {
                const val = input.value;
                if (!/^\d*$/.test(val)) {
                    input.value = "";
                    return;
                }
                if (val.length > 1) {
                    input.value = val.slice(-1);
                }
                if (input.value !== "" && index < 3) {
                    inputs[index + 1].focus();
                }
            });

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace') {
                    if (input.value === "" && index > 0) {
                        inputs[index - 1].focus();
                    }
                }
                if (e.key === 'Enter') {
                    handleGuess();
                }
            });

            input.addEventListener('focus', () => {
                input.select();
            });

            input.addEventListener('paste', (e) => {
                e.preventDefault();
                const pasteData = (e.clipboardData || window.clipboardData).getData('text');
                if (!/^\d{4}$/.test(pasteData)) return;
                const digits = pasteData.split('');
                inputs.forEach((inp, i) => inp.value = digits[i]);
                inputs[3].focus();
            });
        });

        function getInputValue() {
            let val = "";
            inputs.forEach(input => val += input.value);
            return val;
        }

        function validateInput(str) {
            if (str.length !== 4) return "請填滿 4 個數字";
            if (!/^\d+$/.test(str)) return "只能輸入數字";
            const uniqueSet = new Set(str.split(''));
            if (uniqueSet.size !== 4) return "數字不能重複";
            return null;
        }

        function checkAB(guess, ans) {
            let a = 0;
            let b = 0;
            for (let i = 0; i < 4; i++) {
                if (guess[i] === ans[i]) a++;
                else if (ans.includes(guess[i])) b++;
            }
            return `${a}A${b}B`;
        }

        function handleGuess() {
            if (isGameOver) return;
            const val = getInputValue();
            const errorMsg = validateInput(val);

            if (errorMsg) {
                msgBox.textContent = errorMsg;
                msgBox.style.color = "var(--error-color)";
                const container = document.getElementById('inputContainer');
                container.style.transform = "translateX(5px)";
                setTimeout(() => container.style.transform = "translateX(0)", 100);
                setTimeout(() => container.style.transform = "translateX(-5px)", 200);
                setTimeout(() => container.style.transform = "translateX(0)", 300);
                return;
            }

            count++;
            guessCountSpan.textContent = count;
            msgBox.textContent = "";

            const result = checkAB(val, answer);

            currentResultDiv.textContent = result;
            currentResultDiv.classList.add('show');
            if (result === "4A0B") {
                currentResultDiv.classList.add('win');
            } else {
                currentResultDiv.classList.remove('win');
            }

            historyData.push({ guess: val, result: result });
            renderHistoryDOM(val, result);

            if (result !== "4A0B") {
                inputs.forEach(input => input.value = "");
                inputs[0].focus();
                saveGameState();
            } else {
                isGameOver = true;
                saveGameState();
                gameWinUI();
            }
        }

        function renderHistoryDOM(guess, result) {
            const item = document.createElement('div');
            item.className = 'history-item';
            let resultClass = 'result-text';
            if (result === "4A0B") resultClass += ' result-success';

            item.innerHTML = `
                <span class="guess-val">${guess}</span>
                <span class="${resultClass}">${result}</span>
            `;
            historyList.prepend(item);
        }

        function gameWinUI() {
            msgBox.textContent = `恭喜！你用了 ${count} 次猜中答案！`;
            msgBox.style.color = "var(--success-color)";
            inputs.forEach(input => input.disabled = true);
            submitBtn.disabled = true;
            restartBtn.style.display = "block";
        }

        submitBtn.addEventListener('click', handleGuess);

        restartBtn.addEventListener('click', () => {
            initGame(true);
        });

        loadGameState();
