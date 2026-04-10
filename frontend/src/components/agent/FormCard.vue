<script setup lang="ts">
import { ref } from 'vue'
import MCard from '@/components/ui/MCard.vue'
import MButton from '@/components/ui/MButton.vue'

defineProps<{
  type: 'deposit' | 'withdraw'
}>()

const emit = defineEmits<{
  submit: [amount: string]
}>()

const amount = ref('')
</script>

<template>
  <MCard class="border-l-4 border-l-cipher my-2">
    <p class="text-sm font-sans font-medium text-midnight dark:text-white mb-4">
      {{ type === 'deposit' ? 'Quick Deposit' : 'Quick Withdraw' }}
    </p>
    <div class="flex gap-2">
      <div class="relative flex-1">
        <span class="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-cool">$</span>
        <input
          v-model="amount"
          placeholder="0.00"
          class="w-full pl-7 pr-3 py-2 text-sm font-mono border border-haze dark:border-white/10 rounded-xl bg-white dark:bg-midnight text-midnight dark:text-white focus:outline-none focus:border-compute transition-colors"
        />
      </div>
      <MButton size="sm" @click="emit('submit', amount)">
        {{ type === 'deposit' ? 'Deposit' : 'Withdraw' }}
      </MButton>
    </div>
  </MCard>
</template>
