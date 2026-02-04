export const fetchKataGoAnalysis = async (moves: string[], komi: number = 6.5): Promise<any | null> => {
    // Retry configuration
    const maxRetries = 3;
    const endpoint = "https://katago-proxy.vercel.app/api/katago";
    
    for (let i = 0; i < maxRetries; i++) {
        const requestId = Math.random().toString();
        
        try {
            // Abort controller for timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 20000); 

            // Strict payload structure required by the proxy/KataGo
            const payload = {
                board_size: 19,
                moves: moves,
                config: { 
                    komi: komi, 
                    request_id: requestId 
                }
            };

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text().catch(() => 'No error details');
                console.warn(`KataGo server error: ${response.status}`, errorText);
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
            
            const data = await response.json();
            
            // Validate Request ID
            const receivedId = data.request_id || data.config?.request_id;
            
            // Loose comparison
            if (receivedId !== undefined && receivedId !== null && String(receivedId) !== requestId) {
                console.warn(`KataGo ID mismatch: expected ${requestId}, got ${receivedId}. Retrying...`);
                await new Promise(r => setTimeout(r, 500));
                continue;
            }

            return data;

        } catch (error) {
            console.warn(`KataGo fetch attempt ${i + 1} failed:`, error);
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    
    console.error("KataGo analysis failed after max retries.");
    return null;
}