<script>
import {GlIcon} from '@gitlab/ui'

export default {
    name: 'Redacted',
    components: {
        GlIcon
    },
    props: {
        value: {
            type: String,
            default: null,
        }
    },
    data() {
        return {
            isHidden: true
        }
    },
    methods: {
        toggle() {
            this.isHidden = !this.isHidden
        }
    }
}
</script>

<template>
    <div v-if="value" class="redacted-container">
        <div class="mr-1" style="max-width: calc(100% - 16px)" :style="isHidden? 'overflow: hidden': 'overflow: auto'">

            <span v-if="isHidden"> {{value.replace(/./g, '*')}}</span>
            <span v-else style="line-break: anywhere">{{ value }}</span>
        </div>
        <gl-icon @click="toggle" :name="isHidden ? 'eye' : 'eye-slash'" style="cursor: pointer"/>
    </div>
</template>

<style scoped>
.redacted-container {
    display: flex;
    flex-direction: row;
    justify-content: space-between;
    align-items: center;
}

</style>
